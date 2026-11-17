use aeon_core::{CompileOptions, CompileResult, compile};

const CHANNELS: [(&str, &str); 7] = [
    ("/*", "*/"),
    ("/#", "#/"),
    ("/@", "@/"),
    ("/?", "?/"),
    ("/{", "}/"),
    ("/[", "]/"),
    ("/(", ")/"),
];

fn compilers() -> Vec<fn(&str, CompileOptions) -> CompileResult> {
    vec![
        compile,
        #[cfg(feature = "sofia")]
        aeon_core::compile_sofia,
    ]
}

fn contexts(comment: &str) -> Vec<String> {
    vec![
        format!("a=3e3 {comment}b=399"),
        format!("o={{a=3e3 {comment}b=399}}"),
        format!("v=[3e3 {comment}399]"),
        format!("v=(3e3 {comment}399)"),
        format!("v=<n(3e3 {comment}399)>"),
        format!("a@{{x=3e3 {comment}y=399}}=0"),
        format!("aeon:version=\"1.0\" {comment}aeon:mode=\"transport\"\na=1"),
    ]
}

#[test]
fn all_block_channels_retain_newline_separators_in_both_engines() {
    for compiler in compilers() {
        for (opener, closer) in CHANNELS {
            for payload in ["\n", "\r\n", "", "\r", r"\n", "\u{2028}", "\u{2029}"] {
                for source in contexts(&format!("{opener}{payload}{closer}")) {
                    let result = compiler(&source, CompileOptions::default());
                    assert_eq!(
                        result.errors.is_empty(),
                        payload.contains('\n'),
                        "{source:?}: {:?}",
                        result.errors
                    );
                }
            }
            let source = format!("a {opener}\n{closer}=1");
            assert!(
                compiler(&source, CompileOptions::default())
                    .errors
                    .is_empty()
            );
        }
    }
}

#[test]
fn comments_do_not_change_literal_boundaries_or_unterminated_errors() {
    for compiler in compilers() {
        for source in [
            "a=`/*\n*/` b=2",
            "a=>`/*\n*/` b=2",
            "a=\"/*\\n*/\" b=2",
            "a=tr/*\n*/ue",
            "a=3e/*\n*/3",
        ] {
            assert!(
                !compiler(source, CompileOptions::default())
                    .errors
                    .is_empty(),
                "{source}"
            );
        }
        for (opener, _) in CHANNELS {
            let result = compiler(&format!("a=1 {opener}\n"), CompileOptions::default());
            assert!(
                result
                    .errors
                    .iter()
                    .any(|error| error.code == "UNTERMINATED_BLOCK_COMMENT")
            );
        }
    }
}
