//! Build and installed development policy are both mandatory; no environment override.
pub fn validate(compiled: bool, development: bool, opted_in: bool) -> Result<(), &'static str> {
    if compiled && !(development && opted_in) {
        return Err("browser-actions requires an explicit development manifest opt-in");
    }
    if opted_in && !compiled {
        return Err("browser-actions is unavailable in this native build");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn only_explicit_development_feature_can_enable_control() {
        for compiled in [false, true] {
            for development in [false, true] {
                for opted_in in [false, true] {
                    assert_eq!(
                        super::validate(compiled, development, opted_in).is_ok(),
                        (!compiled && !opted_in) || (compiled && development && opted_in)
                    );
                }
            }
        }
    }
}
