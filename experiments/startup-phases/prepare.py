"""Apply #339's passive phase markers to one private pinned dependency checkout."""

import difflib
import hashlib
import json
import os
import subprocess
from pathlib import Path

TRIALS = (1, 2, 3)
PIN = "ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d"
PRIOR_RESEARCH = "055c92bc44d5c63667c6a7360fefcf35074768e5"
PATHS = (
    "crates/gpui_wgpu/src/wgpu_context.rs",
    "crates/gpui_linux/src/linux/x11/window.rs",
    "crates/gpui_wgpu/src/wgpu_renderer.rs",
)
SOURCE_PATHS = (
    "toolchain.json",
    "rust-toolchain.toml",
    "Cargo.toml",
    "Cargo.lock",
    "bun.lock",
    "packages/runtime/src/index.ts",
    "tests/native/lifecycle.ts",
    "scripts/quality/native-linux-session.sh",
    "scripts/quality/native-input-linux.py",
    "scripts/quality/native-paint-observer.py",
    ".github/workflows/startup-phases.yml",
    "experiments/startup-phases/prepare.py",
    "experiments/startup-phases/run.py",
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"Expected exactly one pinned source anchor: {old}")
    return text.replace(old, new)


def instrument(originals):
    """Keep original backend selection and operations; insert bounded log sites."""
    text = originals[PATHS[0]].decode()
    old = """    pub fn instance(display: Option<Box<dyn wgpu::wgt::WgpuHasDisplayHandle>>) -> wgpu::Instance {
        wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::GL,
            flags: wgpu::InstanceFlags::default(),
            backend_options: wgpu::BackendOptions::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            display,
        })
    }"""
    new = """    pub fn instance(display: Option<Box<dyn wgpu::wgt::WgpuHasDisplayHandle>>) -> wgpu::Instance {
        log::info!("BN_PHASE instance_enter");
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN | wgpu::Backends::GL,
            flags: wgpu::InstanceFlags::default(),
            backend_options: wgpu::BackendOptions::default(),
            memory_budget_thresholds: wgpu::MemoryBudgetThresholds::default(),
            display,
        });
        log::info!("BN_PHASE instance_return");
        instance
    }"""
    text = replace_once(text, old, new)
    for label, old in [
        (
            "enumerate",
            "        let mut adapters: Vec<_> = instance.enumerate_adapters(wgpu::Backends::all()).await;",
        ),
        ("surface_caps", "        let caps = surface.get_capabilities(adapter);"),
        ("surface_configure", "        surface.configure(&device, &surface_config);"),
        ("error_scope", "        let error = error_scope.pop().await;"),
    ]:
        text = replace_once(
            text,
            old,
            f'        log::info!("BN_PHASE {label}_enter");\n{old}\n'
            f'        log::info!("BN_PHASE {label}_return");',
        )
    text = replace_once(
        text,
        "        let (device, queue) = adapter\n",
        '        log::info!("BN_PHASE device_request_enter");\n'
        "        let bn_device_request_result = adapter\n",
    )
    old = '            .map_err(|e| anyhow::anyhow!("Failed to create wgpu device: {e}"))?;'
    text = replace_once(
        text,
        old,
        old.removesuffix("?;")
        + ";\n"
        + result_marker("device_request", "bn_device_request_result")
        + "        let (device, queue) = bn_device_request_result?;",
    )
    old = """        let (surface_config, _, _) =
            WgpuRenderer::surface_configuration(surface, adapter, &device, config)?;"""
    text = replace_once(
        text,
        old,
        '        log::info!("BN_PHASE surface_configuration_enter");\n'
        + "        let bn_surface_configuration_result =\n"
        + "            WgpuRenderer::surface_configuration(surface, adapter, &device, config);\n"
        + result_marker("surface_configuration", "bn_surface_configuration_result")
        + "        let (surface_config, _, _) = bn_surface_configuration_result?;",
    )
    patched = {PATHS[0]: text.encode()}

    text = originals[PATHS[1]].decode()
    old = "        let visual_set = find_visuals(xcb, x_screen_index);"
    text = replace_once(
        text,
        old,
        "        let bn_first_window = gpu_context.borrow().is_none();\n" + old,
    )
    old = """            check_reply(
                || format!("X11 CreateColormap failed. id: {}", id),
                xcb.create_colormap(xproto::ColormapAlloc::NONE, id, visual_set.root, visual.id),
            )?;"""
    text = replace_once(
        text,
        old,
        first_window_marker("x11_colormap_enter", 12)
        + old
        + "\n"
        + first_window_marker("x11_colormap_return", 12).rstrip(),
    )
    old = "        let win_aux = xproto::CreateWindowAux::new()"
    text = replace_once(text, old, first_window_marker("x11_setup_enter", 8) + old)
    old = "                WgpuRenderer::new(gpu_context, &raw_window, config, compositor_gpu)?"
    new = (
        first_window_marker("x11_setup_return", 16)
        + first_window_marker("renderer_enter", 16)
        + "                let renderer = WgpuRenderer::new(gpu_context, &raw_window, config, compositor_gpu)?;\n"
        + first_window_marker("renderer_return", 16)
        + "                renderer"
    )
    text = replace_once(text, old, new)
    patched[PATHS[1]] = text.encode()

    text = originals[PATHS[2]].decode()
    old = "        let instance = gpu_context\n"
    text = replace_once(
        text,
        old,
        "        let bn_first_window = gpu_context.borrow().is_none();\n" + old,
    )
    old = """        // Safety: The caller guarantees that the window handle is valid for the
        // lifetime of this renderer. In practice, the RawWindow struct is created
        // from the native window handles and the surface is dropped before the window.
        let surface = unsafe {
            instance
                .create_surface_unsafe(target)
                .map_err(|e| anyhow::anyhow!("Failed to create surface: {e}"))?
        };"""
    text = replace_once(
        text,
        old,
        first_window_marker("surface_create_enter", 8)
        + old
        + "\n"
        + first_window_marker("surface_create_return", 8).rstrip(),
    )
    patched[PATHS[2]] = text.encode()
    return patched


def first_window_marker(phase, indent):
    spaces = " " * indent
    return (
        f"{spaces}if bn_first_window {{\n"
        f'{spaces}    log::info!("BN_PHASE {phase}");\n'
        f"{spaces}}}\n"
    )


def result_marker(phase, result):
    """Record recoverable adapter errors before the original Result propagation."""
    return (
        f'        log::info!("BN_PHASE {phase}_{{}}", '
        f'if {result}.is_ok() {{ "return" }} else {{ "error" }});\n'
    )


def source_hashes(repository):
    return {path: digest((repository / path).read_bytes()) for path in SOURCE_PATHS}


def pinned_originals(dependency):
    head = subprocess.check_output(
        ["git", "-C", str(dependency), "rev-parse", "HEAD"], text=True
    ).strip()
    if head != PIN:
        raise ValueError(f"Unexpected dependency revision: {head}")
    originals = {}
    for path in PATHS:
        source = dependency / path
        if source.is_symlink() or not source.resolve().is_relative_to(
            dependency.resolve()
        ):
            raise ValueError(f"Refuse a source outside the private checkout: {path}")
        original = subprocess.check_output(
            ["git", "-C", str(dependency), "show", f"{PIN}:{path}"]
        )
        if source.read_bytes() != original:
            raise ValueError(f"Refuse an already modified dependency: {path}")
        originals[path] = original
    return originals


def main():
    repository = Path(os.environ["GITHUB_WORKSPACE"]).resolve()
    root = Path(os.environ["STARTUP_PHASE_ROOT"]).resolve()
    cargo_home = Path(os.environ["CARGO_HOME"]).resolve()
    evidence = root / "evidence"
    if cargo_home != root / "cargo":
        raise ValueError(
            "CARGO_HOME must be the explicitly owned experiment root/cargo"
        )
    trial = int(os.environ["STARTUP_PHASE_TRIAL"])
    if trial not in TRIALS:
        raise ValueError("Trial is outside the predeclared three-runner plan")
    if (
        json.loads((repository / "toolchain.json").read_text())["gpui"]["revision"]
        != PIN
    ):
        raise ValueError("The repository no longer uses the investigated GPUI pin")
    matches = []
    for candidate in cargo_home.glob(
        "git/checkouts/zed-*/*/crates/gpui_wgpu/src/wgpu_context.rs"
    ):
        dependency = candidate.parents[3].resolve()
        if not dependency.is_relative_to(cargo_home):
            raise ValueError("Refuse a dependency outside the private Cargo home")
        head = subprocess.check_output(
            ["git", "-C", str(dependency), "rev-parse", "HEAD"], text=True
        ).strip()
        if head == PIN:
            matches.append(dependency)
    if len(matches) != 1:
        raise ValueError(f"Expected one private pinned checkout, found {matches}")
    dependency = matches[0]
    originals = pinned_originals(dependency)
    patched = instrument(originals)
    patch = "".join(
        "".join(
            difflib.unified_diff(
                originals[path].decode().splitlines(True),
                patched[path].decode().splitlines(True),
                fromfile=f"a/{path}",
                tofile=f"b/{path}",
            )
        )
        for path in PATHS
    )
    receipt = {
        "scope": "Instrumented original-backend research only; not qualification",
        "source": subprocess.check_output(
            ["git", "-C", str(repository), "rev-parse", "HEAD"], text=True
        ).strip(),
        "priorResearchSource": PRIOR_RESEARCH,
        "gpuiRevision": PIN,
        "backendSelection": "Vulkan|GL (unchanged)",
        "trial": trial,
        "predeclaredTrials": list(TRIALS),
        "lifecycleProcessesPerTrial": 1,
        "warmups": 0,
        "retries": 0,
        "originalRequestDeadlineMs": 5000,
        "outerFixtureDeadlineSeconds": 45,
        "dependency": str(dependency),
        "sourceSha256": source_hashes(repository),
        "files": [
            {
                "path": path,
                "originalSha256": digest(originals[path]),
                "instrumentedSha256": digest(patched[path]),
            }
            for path in PATHS
        ],
        "patchSha256": digest(patch.encode()),
    }
    evidence.mkdir()
    (evidence / "plan.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (evidence / "dependency.patch").write_text(patch)
    for path, content in patched.items():
        (dependency / path).write_bytes(content)
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
