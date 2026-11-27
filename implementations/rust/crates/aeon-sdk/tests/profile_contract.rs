use aeon_core::{BehaviorMode, CompileOptions, DatatypePolicy};
use altopelago_aeon::profiles::load_profile_contract;

const PROFILE: &str = r#"
profile_id = "aeon.gp.profile.v1"
profile_version = "1.1.0"
core_id = "aeon.core.v1"
mode_default = "strict"
datatype_policy_default = "reserved_only"
collections = {}
containers = {}
datatype_semantics = {
    symbol = { literal_family = "SymbolicLiteral", clarifiers = "none" }
    marker = { literal_family = "SymbolicLiteral", clarifiers = "none" }
}
generic_admission = {
    reserved_datatypes = ["symbol"]
    custom_labels = true
    custom_value_kinds = ["SymbolicLiteral"]
    node_head_datatypes = ["node"]
    binding_node_reserved_arguments = ["node"]
}
capabilities = { references = true, clones = true }
"#;

#[test]
fn the_selected_artifact_supplies_generic_and_clarifier_rules() {
    let policy = load_profile_contract(PROFILE).expect("policy");
    let generic = "duration:symbol<time> = |1min|";
    assert!(
        policy
            .compile(generic, CompileOptions::default())
            .errors
            .is_empty()
    );
    let restrict = load_profile_contract(&PROFILE.replace(
        "reserved_datatypes = [\"symbol\"]",
        "reserved_datatypes = []",
    ))
    .expect("altered generic rules");
    let options = CompileOptions {
        profile: Some("set.to.eleven.v1".into()),
        ..CompileOptions::default()
    };
    let result = restrict.compile(
        &format!("aeon:profile = \"set.to.eleven.v1\"\n{generic}"),
        options,
    );
    assert_eq!(
        result.errors[0].code,
        "PROFILE_DATATYPE_GENERIC_NOT_ALLOWED"
    );

    let source = "duration:symbol<time>[\"minutes\"] = |1min|";
    assert_eq!(
        policy.compile(source, CompileOptions::default()).errors[0].code,
        "PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED"
    );
    let admit = load_profile_contract(&PROFILE.replacen(
        "clarifiers = \"none\"",
        "clarifiers = \"separator_chars\"",
        1,
    ))
    .expect("altered clarifier rules");
    assert!(
        admit
            .compile(source, CompileOptions::default())
            .errors
            .is_empty()
    );
}

#[test]
fn defaults_and_custom_literal_rules_flow_to_native_compilation() {
    let policy = load_profile_contract(PROFILE).expect("policy");
    assert_eq!(policy.mode_default, Some(BehaviorMode::Strict));
    assert_eq!(
        policy.datatype_policy_default,
        Some(DatatypePolicy::ReservedOnly)
    );
    assert!(policy.capabilities.references && policy.capabilities.clones);
    assert_eq!(
        policy.compile("x = 0", CompileOptions::default()).errors[0].code,
        "UNTYPED_VALUE_IN_STRICT_MODE"
    );

    let options = CompileOptions {
        mode: Some(BehaviorMode::Transport),
        datatype_policy: Some(DatatypePolicy::AllowCustom),
        ..CompileOptions::default()
    };
    let source = "value:symbol = |alpha|\nother:marker<symbol> = ~value";
    assert!(policy.compile(source, options.clone()).errors.is_empty());
    let other = load_profile_contract(&PROFILE.replace(
        "custom_value_kinds = [\"SymbolicLiteral\"]",
        "custom_value_kinds = [\"ListNode\"]",
    ))
    .expect("altered literal rules");
    let result = other.compile(source, options.clone());
    assert_eq!(result.errors[0].code, "DATATYPE_LITERAL_MISMATCH");
    assert_eq!(result.errors[0].path.as_deref(), Some("$.other"));
    let result = policy.compile("x@{meta:marker = 0} = 0", options);
    assert_eq!(result.errors[0].code, "DATATYPE_LITERAL_MISMATCH");
    assert_eq!(result.errors[0].path.as_deref(), Some("$.x.@.meta"));
}

#[test]
fn malformed_or_decorated_artifacts_are_rejected() {
    for source in [
        format!("aeon:header = {{}}\n{PROFILE}"),
        PROFILE.replace("profile_id =", "profile_id:string ="),
        PROFILE.replace(
            "profile_version = \"1.1.0\"",
            "profile_version = \"1.1.0-01\"",
        ),
        PROFILE.replace("core_id = \"aeon.core.v1\"", "core_id = \"other.core.v1\""),
        PROFILE.replace("custom_labels = true", "custom_labels = ~profile_id"),
        PROFILE.replace("custom_labels = true", "custom_labels = yes"),
        PROFILE.replace(
            "reserved_datatypes = [\"symbol\"]",
            "reserved_datatypes = [\"symbol\", \"symbol\"]",
        ),
        PROFILE.replace(
            "reserved_datatypes = [\"symbol\"]",
            "reserved_datatypes = [:string = \"symbol\"]",
        ),
        PROFILE.replace(
            "custom_value_kinds = [\"SymbolicLiteral\"]",
            "custom_value_kinds = [\"Unspecified\"]",
        ),
        PROFILE.replace("capabilities =", "unrecognized ="),
    ] {
        assert!(load_profile_contract(&source).is_err(), "{source}");
    }
}

#[test]
fn profile_records_require_named_fields() {
    let (before_admission, admission) = PROFILE
        .split_once("generic_admission =")
        .expect("admission field");
    let (_, capabilities) = admission
        .split_once("capabilities =")
        .expect("capabilities field");
    for (source, path) in [
        (
            PROFILE.replace(
                "capabilities = { references = true, clones = true }",
                "capabilities = [true, false]",
            ),
            "$.capabilities",
        ),
        (
            format!(
                "{before_admission}generic_admission = [[\"symbol\"], true, [\"SymbolicLiteral\"], [\"node\"], [\"node\"]]\ncapabilities ={capabilities}"
            ),
            "$.generic_admission",
        ),
        (
            PROFILE.replace(
                "collections = {}",
                "collections = { list = [false, true, false, false] }",
            ),
            "$.collections.list",
        ),
        (
            PROFILE.replace(
                "containers = {}",
                "containers = { object = [false, true, true] }",
            ),
            "$.containers.object",
        ),
        (
            PROFILE.replace(
                "containers = {}",
                "containers = { node = [true, true, true, true] }",
            ),
            "$.containers.node",
        ),
        (
            PROFILE.replace(
                "symbol = { literal_family = \"SymbolicLiteral\", clarifiers = \"none\" }",
                "symbol = [\"SymbolicLiteral\", \"none\"]",
            ),
            "$.datatype_semantics.symbol",
        ),
    ] {
        let error = load_profile_contract(&source).expect_err("positional record");
        assert_eq!(error.path, path);
    }
}

#[test]
fn omitted_generic_admission_preserves_core_and_other_profile_rules() {
    let (before_admission, rest) = PROFILE
        .split_once("generic_admission =")
        .expect("admission");
    let (_, capabilities) = rest.split_once("capabilities =").expect("capabilities");
    let legacy = format!("{before_admission}capabilities ={capabilities}");
    let policy = load_profile_contract(&legacy.replace("1.1.0", "1.0.0")).expect("older profile");
    assert!(policy.datatype_rules().generic_admission.is_none());

    let options = CompileOptions {
        datatype_policy: Some(DatatypePolicy::AllowCustom),
        ..CompileOptions::default()
    };
    for source in [
        "x:number<symbol> = 1",
        "x:domain<number> = |alpha|",
        "x:marker<symbol> = |alpha|",
    ] {
        assert!(
            policy.compile(source, options.clone()).errors.is_empty(),
            "{source}"
        );
    }
    for (source, code) in [
        ("x:marker<number> = 1", "DATATYPE_LITERAL_MISMATCH"),
        (
            "x:symbol<time>[\"minutes\"] = |1min|",
            "PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED",
        ),
    ] {
        assert_eq!(
            policy.compile(source, options.clone()).errors[0].code,
            code,
            "{source}"
        );
    }
}

#[test]
fn the_loaded_gp_clarifier_table_is_closed() {
    let artifact = PROFILE.replace(
        "datatype_semantics = {",
        "datatype_semantics = {\n    sep = { literal_family = \"SeparatorLiteral\", clarifiers = \"separator_chars\" }\n    radix = { literal_family = \"RadixLiteral\", clarifiers = \"radix_base\" }",
    );
    let gp = load_profile_contract(&artifact).expect("GP policy");
    let custom = load_profile_contract(&artifact.replace("aeon.gp.profile.v1", "local.profile.v1"))
        .expect("custom policy");
    let options = CompileOptions {
        datatype_policy: Some(DatatypePolicy::AllowCustom),
        ..CompileOptions::default()
    };
    for source in ["a:ipv[\".\"] = ^a.b", "a:mask[2] = %1"] {
        let result = gp.compile(source, options.clone());
        assert_eq!(result.errors.len(), 1, "{source}");
        assert_eq!(
            result.errors[0].code, "PROFILE_DATATYPE_CLARIFIER_NOT_ALLOWED",
            "{source}"
        );
        assert!(
            custom.compile(source, options.clone()).errors.is_empty(),
            "{source}"
        );
    }
    for source in ["a:sep[\".\"] = ^a.b", "a:radix[2] = %1"] {
        assert!(
            gp.compile(source, options.clone()).errors.is_empty(),
            "{source}"
        );
    }
}

#[test]
fn omitted_mode_default_defers_to_the_authored_mode() {
    let policy = load_profile_contract(&PROFILE.replace("mode_default = \"strict\"", ""))
        .expect("profile with no default mode");
    assert_eq!(policy.mode_default, None);
    assert!(
        policy
            .compile("x = 0", CompileOptions::default())
            .errors
            .is_empty()
    );
    assert_eq!(
        policy
            .compile("aeon:mode = \"strict\"\nx = 0", CompileOptions::default())
            .errors[0]
            .code,
        "UNTYPED_VALUE_IN_STRICT_MODE"
    );
}
