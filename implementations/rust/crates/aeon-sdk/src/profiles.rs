//! Load caller-selected AEON profile contracts and reuse their datatype rules.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::Arc;

use aeon_core::{
    AeonCompileLimits, Binding, CompileResult, Value, compile, is_reserved_datatype_name,
    parse_document,
};
pub use aeon_core::{
    BehaviorMode, ClarifierRule, CompileOptions, DatatypePolicy, DatatypeSemantics,
    GenericAdmissionPolicy, ProfileDatatypeRules,
};
use serde::Deserialize;
use serde_json::{Map, Value as JsonValue};

/// A reusable policy decoded from a Core v1 profile artifact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfilePolicy {
    pub id: String,
    pub version: String,
    pub core_id: String,
    pub description: Option<String>,
    pub mode_default: Option<BehaviorMode>,
    pub datatype_policy_default: Option<DatatypePolicy>,
    pub collections: CollectionPolicies,
    pub containers: ContainerPolicies,
    pub capabilities: Capabilities,
    datatype_rules: Arc<ProfileDatatypeRules>,
}

impl ProfilePolicy {
    #[must_use]
    pub fn datatype_rules(&self) -> &ProfileDatatypeRules {
        &self.datatype_rules
    }

    /// Apply the selected policy without changing the caller's explicit mode,
    /// datatype policy, or resource limits.
    #[must_use]
    pub fn compile_options(&self, mut options: CompileOptions) -> CompileOptions {
        options.mode = options.mode.or(self.mode_default);
        options.datatype_policy = options.datatype_policy.or(self.datatype_policy_default);
        options.profile_datatype_rules = Some(Arc::clone(&self.datatype_rules));
        options
    }

    /// Compile with the loaded rules. A header cannot replace the selected policy.
    #[must_use]
    pub fn compile(&self, source: &str, options: CompileOptions) -> CompileResult {
        compile(source, self.compile_options(options))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionPolicies {
    pub list: Option<CollectionPolicy>,
    pub tuple: Option<CollectionPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CollectionPolicy {
    pub ordered: bool,
    pub heterogeneous: bool,
    pub unique: bool,
    pub fixed_length: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContainerPolicies {
    pub object: Option<ObjectPolicy>,
    pub node: Option<NodePolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObjectPolicy {
    pub ordered: bool,
    pub heterogeneous: bool,
    pub unique_keys: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodePolicy {
    pub ordered: bool,
    pub heterogeneous: bool,
    pub unique_attributes: bool,
    pub mixed_content: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capabilities {
    pub references: bool,
    pub clones: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileContractError {
    pub path: String,
    pub message: String,
}

impl fmt::Display for ProfileContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Invalid AEON profile contract at {}: {}",
            self.path, self.message
        )
    }
}

impl std::error::Error for ProfileContractError {}

fn invalid(path: impl Into<String>, message: impl Into<String>) -> ProfileContractError {
    ProfileContractError {
        path: path.into(),
        message: message.into(),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileDocument {
    profile_id: String,
    profile_version: String,
    core_id: CoreId,
    description: Option<String>,
    mode_default: Option<Mode>,
    datatype_policy_default: Option<Policy>,
    collections: CollectionPolicies,
    containers: ContainerPolicies,
    datatype_semantics: BTreeMap<String, Semantics>,
    generic_admission: Option<Admission>,
    capabilities: Capabilities,
}

#[derive(Deserialize)]
enum CoreId {
    #[serde(rename = "aeon.core.v1")]
    V1,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Transport,
    Strict,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Policy {
    ReservedOnly,
    AllowCustom,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Semantics {
    literal_family: String,
    clarifiers: Clarifiers,
    alias_of: Option<String>,
    equivalent_to: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Clarifiers {
    None,
    RadixBase,
    SeparatorChars,
    EncodingName,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Admission {
    reserved_datatypes: Vec<String>,
    custom_labels: bool,
    custom_value_kinds: Vec<String>,
    node_head_datatypes: Vec<String>,
    binding_node_reserved_arguments: Vec<String>,
}

const LITERAL_KINDS: &[&str] = &[
    "StringLiteral",
    "TrimtickStringLiteral",
    "NumberLiteral",
    "InfinityLiteral",
    "NaNLiteral",
    "NullLiteral",
    "BooleanLiteral",
    "ToggleLiteral",
    "HexLiteral",
    "RadixLiteral",
    "EncodingLiteral",
    "SeparatorLiteral",
    "SymbolicLiteral",
    "SansaAddressLiteral",
    "DateLiteral",
    "TimeLiteral",
    "DateTimeLiteral",
    "WTCDateTimeLiteral",
];

/// Decode a trusted, caller-selected profile artifact. Profile contracts use
/// plain body bindings, objects, lists, strings, and booleans. References,
/// datatype annotations, and structural identities are unavailable here.
pub fn load_profile_contract(source: &str) -> Result<ProfilePolicy, ProfileContractError> {
    let bindings = parse_document(source, &AeonCompileLimits::default()).map_err(|errors| {
        errors.first().map_or_else(
            || invalid("$", "Core did not produce a document"),
            |error| {
                invalid(
                    error.path.as_deref().unwrap_or("$"),
                    format!("{}: {}", error.code, error.message),
                )
            },
        )
    })?;
    let document = plain_object(bindings, "$")?;
    validate_record_shapes(&document)?;
    let parsed: ProfileDocument =
        serde_json::from_value(document).map_err(|error| invalid("$", error.to_string()))?;
    if parsed.profile_id.is_empty() || parsed.profile_id.trim() != parsed.profile_id {
        return Err(invalid(
            "$.profile_id",
            "expected a nonempty profile identifier",
        ));
    }
    if !is_semantic_version(&parsed.profile_version) {
        return Err(invalid("$.profile_version", "expected a semantic version"));
    }
    let CoreId::V1 = parsed.core_id;
    let generic_admission = parsed.generic_admission.map(read_admission).transpose()?;
    let mut datatype_semantics = BTreeMap::new();
    for (name, rule) in parsed.datatype_semantics {
        if !is_datatype_name(&name) {
            return Err(invalid(
                format!("$.datatype_semantics.{name}"),
                "expected a datatype name",
            ));
        }
        if !LITERAL_KINDS.contains(&rule.literal_family.as_str()) {
            return Err(invalid(
                format!("$.datatype_semantics.{name}.literal_family"),
                "unsupported literal family",
            ));
        }
        datatype_semantics.insert(
            name,
            DatatypeSemantics {
                literal_family: rule.literal_family,
                clarifiers: match rule.clarifiers {
                    Clarifiers::None => ClarifierRule::None,
                    Clarifiers::RadixBase => ClarifierRule::RadixBase,
                    Clarifiers::SeparatorChars => ClarifierRule::SeparatorChars,
                    Clarifiers::EncodingName => ClarifierRule::EncodingName,
                },
                alias_of: rule.alias_of,
                equivalent_to: rule.equivalent_to,
            },
        );
    }

    let closed_clarifiers = parsed.profile_id == "aeon.gp.profile.v1";
    Ok(ProfilePolicy {
        id: parsed.profile_id,
        version: parsed.profile_version,
        core_id: "aeon.core.v1".to_owned(),
        description: parsed.description,
        mode_default: parsed.mode_default.map(|mode| match mode {
            Mode::Transport => BehaviorMode::Transport,
            Mode::Strict => BehaviorMode::Strict,
        }),
        datatype_policy_default: parsed.datatype_policy_default.map(|policy| match policy {
            Policy::ReservedOnly => DatatypePolicy::ReservedOnly,
            Policy::AllowCustom => DatatypePolicy::AllowCustom,
        }),
        collections: parsed.collections,
        containers: parsed.containers,
        capabilities: parsed.capabilities,
        datatype_rules: Arc::new(ProfileDatatypeRules {
            generic_admission,
            datatype_semantics,
            closed_clarifiers,
        }),
    })
}

fn read_admission(admission: Admission) -> Result<GenericAdmissionPolicy, ProfileContractError> {
    Ok(GenericAdmissionPolicy {
        reserved_datatypes: names(
            admission.reserved_datatypes,
            "reserved_datatypes",
            is_reserved_datatype_name,
        )?,
        custom_labels: admission.custom_labels,
        custom_value_kinds: names(admission.custom_value_kinds, "custom_value_kinds", |name| {
            LITERAL_KINDS.contains(&name)
                || matches!(
                    name,
                    "ListNode" | "TupleLiteral" | "ObjectNode" | "NodeLiteral"
                )
        })?,
        node_head_datatypes: names(
            admission.node_head_datatypes,
            "node_head_datatypes",
            is_datatype_name,
        )?,
        binding_node_reserved_arguments: names(
            admission.binding_node_reserved_arguments,
            "binding_node_reserved_arguments",
            is_reserved_datatype_name,
        )?,
    })
}

fn validate_record_shapes(document: &JsonValue) -> Result<(), ProfileContractError> {
    // Serde's derived structs also accept positional sequences. Contract records
    // must use named fields, while the admission lists remain ordinary arrays.
    for name in ["capabilities", "generic_admission"] {
        if document.get(name).is_some_and(|record| !record.is_object()) {
            return Err(invalid(format!("$.{name}"), "expected a named object"));
        }
    }
    for name in ["collections", "containers", "datatype_semantics"] {
        let Some(record) = document.get(name) else {
            continue;
        };
        let members = record
            .as_object()
            .ok_or_else(|| invalid(format!("$.{name}"), "expected a named object"))?;
        for (key, record) in members {
            if !record.is_object() {
                return Err(invalid(
                    format!("$.{name}.{key}"),
                    "expected a named object",
                ));
            }
        }
    }
    Ok(())
}

fn plain_object(bindings: Vec<Binding>, path: &str) -> Result<JsonValue, ProfileContractError> {
    let mut fields = Map::new();
    for binding in bindings {
        let field_path = format!("{path}.{}", binding.key);
        if binding.is_header {
            return Err(invalid(path, "profile contracts use body bindings only"));
        }
        if binding.datatype.is_some()
            || binding.structural_id.is_some()
            || !binding.attributes.is_empty()
        {
            return Err(invalid(field_path, "contract fields use plain bindings"));
        }
        fields.insert(binding.key, plain_value(binding.value, &field_path)?);
    }
    Ok(JsonValue::Object(fields))
}

fn plain_value(value: Value, path: &str) -> Result<JsonValue, ProfileContractError> {
    match value {
        Value::ObjectNode { bindings } => plain_object(bindings, path),
        Value::ListNode { items } => items
            .into_iter()
            .enumerate()
            .map(|(index, item)| plain_value(item, &format!("{path}[{index}]")))
            .collect::<Result<Vec<_>, _>>()
            .map(JsonValue::Array),
        Value::StringLiteral {
            value,
            trimticks: None,
            ..
        } => Ok(JsonValue::String(value)),
        Value::BooleanLiteral { raw } => Ok(JsonValue::Bool(raw == "true")),
        _ => Err(invalid(
            path,
            "expected a plain object, list, string, or boolean",
        )),
    }
}

fn is_datatype_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn names(
    values: Vec<String>,
    field: &str,
    allowed: impl Fn(&str) -> bool,
) -> Result<BTreeSet<String>, ProfileContractError> {
    let mut names = BTreeSet::new();
    for (index, name) in values.into_iter().enumerate() {
        if !allowed(&name) {
            return Err(invalid(
                format!("$.generic_admission.{field}[{index}]"),
                format!("unsupported name {name:?}"),
            ));
        }
        if !names.insert(name) {
            return Err(invalid(
                format!("$.generic_admission.{field}[{index}]"),
                "duplicate name",
            ));
        }
    }
    Ok(names)
}

fn is_semantic_version(version: &str) -> bool {
    fn decimal(value: &str) -> bool {
        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
    }
    fn valid_number(value: &str) -> bool {
        decimal(value) && (value.len() == 1 || !value.starts_with('0'))
    }
    fn identifiers(value: &str, prerelease: bool) -> bool {
        value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && (!prerelease || !decimal(part) || valid_number(part))
        })
    }

    let (version, build) = version
        .split_once('+')
        .map_or((version, None), |(base, build)| (base, Some(build)));
    let (version, prerelease) = version
        .split_once('-')
        .map_or((version, None), |(base, pre)| (base, Some(pre)));
    let mut parts = version.split('.');
    (0..3).all(|_| parts.next().is_some_and(valid_number))
        && parts.next().is_none()
        && prerelease.is_none_or(|pre| identifiers(pre, true))
        && build.is_none_or(|build| identifiers(build, false))
}
