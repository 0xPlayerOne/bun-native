"""Shared file-only receipts for local and hosted installed-consumer qualification.

These helpers inspect and retain existing files and metadata. They execute no compiler,
package installer, application, native window or runtime workload.
"""

import hashlib
import json
import shutil
from pathlib import Path


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    result = hashlib.sha256()
    size = 0
    with Path(path).open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            result.update(chunk)
    return {"bytes": size, "sha256": result.hexdigest()}


def retain_build_diagnostics(project, destination):
    """Retain the actual existing producer logs/launcher before owned cleanup."""
    destination.mkdir()
    files = {}
    for name in (
        "build-metrics.json",
        "compile-aot.stdout.log",
        "compile-aot.stderr.log",
        "launcher.ts",
    ):
        source, retained = project / "dist" / name, destination / name
        require(
            source.is_file() and not source.is_symlink(),
            f"Missing regular AOT build diagnostic: {name}",
        )
        before = digest(source)
        with source.open("rb") as input_file, retained.open("xb") as output_file:
            shutil.copyfileobj(input_file, output_file, 1024 * 1024)
        require(
            digest(source) == before == digest(retained),
            f"AOT build diagnostic changed while retaining it: {name}",
        )
        files[name] = before
    return files


def retained_source(project, original_directory, source_root, name):
    # The CLI has deleted this formerly real dev-* directory. Reduce only its
    # leading parent traversal; normalizing the entire source path could erase
    # an existing symlink/.. escape or a nonexistent intermediate directory.
    origin = original_directory.resolve(strict=False)
    require(
        origin.is_relative_to(project), "Original module directory escapes consumer"
    )
    path = Path(source_root) / name
    if not path.is_absolute():
        parts = list(path.parts)
        while parts and parts[0] == "..":
            origin = origin.parent
            parts.pop(0)
        path = origin.joinpath(*parts)
    return path.resolve(strict=True)


def source_map_receipt(project, source_map, *, original_directory=None):
    mapping = json.loads(source_map.read_text())
    require(mapping["version"] == 3 and mapping["sources"], "Missing source-map inputs")
    sources = {}
    for name in mapping["sources"]:
        if original_directory is None:
            target = (source_map.parent / mapping.get("sourceRoot", "") / name).resolve(
                strict=True
            )
        else:
            target = retained_source(
                project, original_directory, mapping.get("sourceRoot", ""), name
            )
        require(
            target.is_relative_to(project) and target.is_file(),
            f"Source-map input escapes consumer: {name}",
        )
        sources[target.relative_to(project).as_posix()] = digest(target)
    return {
        "source_map": digest(source_map),
        "mapped_sources": sources,
        "source_map_limit": "No original Solid TSX line/column fidelity claim",
    }


def build_receipt(project, source, toolchain, host, bun):
    directory = project / "dist"
    manifest = json.loads((directory / "manifest.json").read_text())
    require(
        manifest["packageSet"]["source"] == source,
        "AOT source identity differs",
    )
    require(
        manifest["packageSet"]["manifest"]
        == digest(project / "vendor/bun-native/manifest.json"),
        "AOT package-set identity differs",
    )
    require(manifest["toolchain"] == toolchain, "AOT toolchain differs")
    require(
        manifest["application"]["inspection"]["hasCompiledProgram"],
        "Compiled-program record missing",
    )
    runtime = manifest["application"]["runtimeFeatures"]
    require(
        runtime["jit"] != "present" and runtime["jitRemovedRanges"]["count"] > 0,
        "JIT omission evidence missing",
    )
    command = manifest["application"]["compileCommand"]
    require(
        command[:3] == ["bun", "--no-install", "compile"],
        "AOT child lost its explicit no-install guard",
    )
    require(
        manifest["application"]["compiler"]
        == {"revision": toolchain["bun"]["revision"], "executable": digest(bun)},
        "AOT compiler identity differs",
    )
    for field in ("application", "developmentModule", "host"):
        item = manifest[field]
        require(
            digest(directory / item["file"])
            == {key: item[key] for key in ("bytes", "sha256")},
            f"AOT {field} bytes differ",
        )
    require(
        digest(directory / manifest["host"]["file"]) == host,
        "Bundled host differs",
    )
    require(
        all(
            manifest["verification"][key] == "not-run"
            for key in ("nativeRendering", "osInput", "teardown")
        ),
        "Build overstates native qualification",
    )
    return {
        "manifest": manifest,
        "manifest_digest": digest(directory / "manifest.json"),
        **source_map_receipt(project, directory / "development/application.js.map"),
    }
