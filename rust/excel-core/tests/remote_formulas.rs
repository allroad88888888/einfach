use einfach_core::{Value, ValueError};

#[test]
fn remote_error_displays_as_remote_bang() {
    let err = ValueError::Remote;
    let s = format!("{}", err);
    assert_eq!(s, "#REMOTE!");
}

#[test]
fn busy_error_displays_as_busy_bang() {
    let err = ValueError::Busy;
    let s = format!("{}", err);
    assert_eq!(s, "#BUSY!");
}

#[test]
fn remote_error_in_value() {
    let v = Value::Error(ValueError::Remote);
    match v {
        Value::Error(e) => assert_eq!(e, ValueError::Remote),
        _ => panic!("expected error value"),
    }
}

mod remote_error_kind_tests {
    use einfach_excel_core::workbook::RemoteErrorKind;

    #[test]
    fn debug_contains_variant_name() {
        let k = RemoteErrorKind::Network;
        let s = format!("{:?}", k);
        assert!(s.contains("Network"));
    }

    #[test]
    fn timeout_maps_correctly() {
        let k = RemoteErrorKind::Timeout;
        assert!(matches!(k, RemoteErrorKind::Timeout));
    }

    #[test]
    fn all_variants_distinct() {
        use RemoteErrorKind::*;
        let variants = [Network, Timeout, InvalidUrl, BadResponse];
        for i in 0..variants.len() {
            for j in (i + 1)..variants.len() {
                assert!(format!("{:?}", variants[i]) != format!("{:?}", variants[j]));
            }
        }
    }
}
