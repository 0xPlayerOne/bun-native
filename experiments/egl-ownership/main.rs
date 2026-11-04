fn main() {
    let mut args = std::env::args_os().skip(1);
    let library = args.next().expect("owned EGL fixture path");
    let case = args.next().expect("case name");
    assert!(args.next().is_none(), "unexpected argument");
    wgpu_hal::gles::run_bun_native_egl_ownership_probe(
        std::path::Path::new(&library),
        case.to_str().expect("UTF-8 case name"),
    );
}
