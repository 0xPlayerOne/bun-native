//! Trusted file bytes require both a contributor build and installed development policy.
//! There is no command-line or environment override.
pub fn validate(compiled: bool, development: bool, opted_in: bool) -> Result<(), &'static str> {
    if compiled && !(development && opted_in) {
        return Err("programmatic-files requires an explicit development manifest opt-in");
    }
    if opted_in && !compiled {
        return Err("programmatic-files is unavailable in this native build");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn feature_and_development_manifest_are_independent_mandatory_gates() {
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
