use std::collections::{BTreeMap, BTreeSet};

use crate::validation::{datatype_base, is_reserved_datatype};
use crate::{Diagnostic, datatype_has_generic_args, gp_datatype_clarifier_rule};

/// Datatype rules selected by a caller for Core validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileDatatypeRules {
    pub generic_admission: GenericAdmissionPolicy,
    pub datatype_semantics: BTreeMap<String, DatatypeSemantics>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenericAdmissionPolicy {
    pub reserved_datatypes: BTreeSet<String>,
    pub custom_labels: bool,
    pub custom_value_kinds: BTreeSet<String>,
    pub node_head_datatypes: BTreeSet<String>,
    pub binding_node_reserved_arguments: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatatypeSemantics {
    pub literal_family: String,
    pub clarifiers: ClarifierRule,
    pub alias_of: Option<String>,
    pub equivalent_to: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClarifierRule {
    None,
    RadixBase,
    SeparatorChars,
    EncodingName,
}

#[derive(Clone, Copy)]
pub(crate) enum DatatypeProfile<'a> {
    BuiltinGp,
    Loaded(&'a ProfileDatatypeRules),
}

impl DatatypeProfile<'_> {
    pub(crate) fn allows_reserved_generic(self, name: &str) -> bool {
        match self {
            Self::BuiltinGp => matches!(
                name,
                "list"
                    | "tuple"
                    | "triple"
                    | "object"
                    | "node"
                    | "null"
                    | "nan"
                    | "infinity"
                    | "symbol"
            ),
            Self::Loaded(rules) => rules.generic_admission.reserved_datatypes.contains(name),
        }
    }

    pub(crate) fn allows_custom_generic(self) -> bool {
        match self {
            Self::BuiltinGp => true,
            Self::Loaded(rules) => rules.generic_admission.custom_labels,
        }
    }

    pub(crate) fn allows_node_head_generic(self, name: &str) -> bool {
        match self {
            Self::BuiltinGp => name == "node",
            Self::Loaded(rules) => rules.generic_admission.node_head_datatypes.contains(name),
        }
    }

    pub(crate) fn allows_binding_node_argument(self, name: &str) -> bool {
        if !is_reserved_datatype(name) {
            return true;
        }
        match self {
            Self::BuiltinGp => name == "node",
            Self::Loaded(rules) => rules
                .generic_admission
                .binding_node_reserved_arguments
                .contains(name),
        }
    }

    pub(crate) fn clarifier_rule(self, name: &str) -> Option<ClarifierRule> {
        match self {
            Self::BuiltinGp => gp_datatype_clarifier_rule(name),
            Self::Loaded(rules) => rules
                .datatype_semantics
                .get(name)
                .map(|rule| rule.clarifiers),
        }
    }

    pub(crate) fn checks_custom_kind(self, datatype: &str) -> bool {
        !is_reserved_datatype(datatype)
            && (matches!(self, Self::Loaded(rules) if rules.datatype_semantics.contains_key(datatype_base(datatype)))
                || (self.allows_custom_generic() && datatype_has_generic_args(datatype)))
    }

    pub(crate) fn custom_value_error(
        self,
        datatype: &str,
        kind: &str,
        path: &str,
    ) -> Option<Diagnostic> {
        if matches!(kind, "CloneReference" | "PointerReference")
            || !self.checks_custom_kind(datatype)
        {
            return None;
        }
        let generic = datatype_has_generic_args(datatype);
        let expected = match self {
            Self::BuiltinGp if matches!(kind, "ListNode" | "TupleLiteral") => return None,
            Self::BuiltinGp => "ListNode or TupleLiteral".to_owned(),
            Self::Loaded(rules) => {
                let admission = &rules.generic_admission;
                if let Some(rule) = rules.datatype_semantics.get(datatype_base(datatype)) {
                    if rule.literal_family == kind
                        && (!generic
                            || !admission.custom_labels
                            || admission.custom_value_kinds.contains(kind))
                    {
                        return None;
                    }
                    if generic
                        && admission.custom_labels
                        && !admission.custom_value_kinds.contains(&rule.literal_family)
                    {
                        "no literal family admitted by the profile".to_owned()
                    } else {
                        rule.literal_family.clone()
                    }
                } else if admission.custom_value_kinds.contains(kind) {
                    return None;
                } else {
                    admission
                        .custom_value_kinds
                        .iter()
                        .map(String::as_str)
                        .collect::<Vec<_>>()
                        .join(" or ")
                }
            }
        };
        Some(Diagnostic::new(
            "DATATYPE_LITERAL_MISMATCH",
            format!("Datatype/literal mismatch at '{path}': datatype ':{datatype}' expects {expected}, got {kind}"),
        ).at_path(path))
    }
}
