"""Fingerprint and instrument only the disposable runner's pinned GPUI checkout."""

import difflib
import hashlib
import json
import os
import subprocess
from pathlib import Path

repository = Path(os.environ["GITHUB_WORKSPACE"])
evidence = Path(os.environ["STARTUP_PHASE_EVIDENCE"])
evidence.mkdir()
variant = os.environ["STARTUP_PHASE_VARIANT"]
assert variant in ("original-backends", "vulkan-only-control")
pin = json.loads((repository / "toolchain.json").read_text())["gpui"]["revision"]
cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
candidates = list(
    cargo_home.glob("git/checkouts/zed-*/*/crates/gpui_wgpu/src/wgpu_context.rs")
)
matching = []
for candidate in candidates:
    dependency = candidate.parents[3]
    head = subprocess.check_output(
        ["git", "-C", str(dependency), "rev-parse", "HEAD"], text=True
    ).strip()
    if head == pin:
        matching.append(dependency)
assert len(matching) == 1, matching
dependency = matching[0]
paths = [
    "crates/gpui_wgpu/src/wgpu_context.rs",
    "crates/gpui_linux/src/linux/x11/window.rs",
]
originals = {}
for path in paths:
    original = subprocess.check_output(
        ["git", "-C", str(dependency), "show", f"HEAD:{path}"]
    )
    assert (dependency / path).read_bytes() == original, (
        "Refuse an already modified dependency"
    )
    originals[path] = original


def replace_once(text, old, new):
    assert text.count(old) == 1, old
    return text.replace(old, new)


path = paths[0]
text = originals[path].decode()
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
if variant == "vulkan-only-control":
    new = new.replace(
        "wgpu::Backends::VULKAN | wgpu::Backends::GL", "wgpu::Backends::VULKAN"
    )
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
        f'        log::info!("BN_PHASE {label}_enter");\n{old}\n        log::info!("BN_PHASE {label}_return");',
    )
text = replace_once(
    text,
    "        let (device, queue) = adapter\n",
    '        log::info!("BN_PHASE device_request_enter");\n        let (device, queue) = adapter\n',
)
old = '            .map_err(|e| anyhow::anyhow!("Failed to create wgpu device: {e}"))?;'
text = replace_once(
    text, old, old + '\n        log::info!("BN_PHASE device_request_return");'
)
old = """        let (surface_config, _, _) =
            WgpuRenderer::surface_configuration(surface, adapter, &device, config)?;"""
text = replace_once(
    text,
    old,
    '        log::info!("BN_PHASE surface_configuration_enter");\n'
    + old
    + '\n        log::info!("BN_PHASE surface_configuration_return");',
)
patched = {path: text.encode()}
path = paths[1]
text = originals[path].decode()
old = """            check_reply(
                || format!("X11 CreateColormap failed. id: {}", id),
                xcb.create_colormap(xproto::ColormapAlloc::NONE, id, visual_set.root, visual.id),
            )?;"""
text = replace_once(
    text, old, old + '\n            log::info!("BN_PHASE x11_colormap_return");'
)
old = "                WgpuRenderer::new(gpu_context, &raw_window, config, compositor_gpu)?"
new = """                log::info!("BN_PHASE renderer_enter");
                let renderer = WgpuRenderer::new(gpu_context, &raw_window, config, compositor_gpu)?;
                log::info!("BN_PHASE renderer_return");
                renderer"""
text = replace_once(text, old, new)
patched[path] = text.encode()
receipt = {
    "scope": "Private dependency instrumentation/counterfactual only; not qualification or a production pin",
    "source": subprocess.check_output(
        ["git", "-C", str(repository), "rev-parse", "HEAD"], text=True
    ).strip(),
    "gpuiRevision": pin,
    "variant": variant,
    "originalRequestDeadlineMs": 5000,
    "outerFixtureDeadlineSeconds": 45,
    "attempts": 1,
    "originalFixtureSha256": hashlib.sha256(
        (repository / "tests/native/lifecycle.ts").read_bytes()
    ).hexdigest(),
    "files": [],
}
patch = ""
for path in paths:
    receipt["files"].append(
        {
            "path": path,
            "originalSha256": hashlib.sha256(originals[path]).hexdigest(),
            "instrumentedSha256": hashlib.sha256(patched[path]).hexdigest(),
        }
    )
    patch += "".join(
        difflib.unified_diff(
            originals[path].decode().splitlines(True),
            patched[path].decode().splitlines(True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
        )
    )
receipt["patchSha256"] = hashlib.sha256(patch.encode()).hexdigest()
(evidence / "plan.json").write_text(json.dumps(receipt, indent=2) + "\n")
(evidence / "dependency.patch").write_text(patch)
for path, content in patched.items():
    (dependency / path).write_bytes(content)
print(json.dumps(receipt, indent=2))
