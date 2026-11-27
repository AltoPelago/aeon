use std::collections::{BTreeMap, BTreeSet};

use crate::validation::{datatype_base, is_reserved_datatype};
use crate::{Diagnostic, datatype_has_generic_args, gp_datatype_clarifier_rule};

/// Datatype rules selected by a caller for Core validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileDatatypeRules {
    /// An omitted record leaves generic admission to Core.
    pub generic_admission: Option<GenericAdmissionPolicy>,
    pub datatype_semantics: BTreeMap<String, DatatypeSemantics>,
    /// Reject clarifiers whose datatype has no declared rule.
    pub closed_clarifiers: bool,
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
    pub(crate) fn enforces_generic_admission(self) -> bool {
        match self {
            Self::BuiltinGp => true,
            Self::Loaded(rules) => rules.generic_admission.is_some(),
        }
    }

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
            Self::Loaded(rules) => rules
                .generic_admission
                .as_ref()
                .is_some_and(|admission| admission.reserved_datatypes.contains(name)),
        }
    }

    pub(crate) fn allows_custom_generic(self) -> bool {
        match self {
            Self::BuiltinGp => true,
            Self::Loaded(rules) => rules
                .generic_admission
                .as_ref()
                .is_some_and(|admission| admission.custom_labels),
        }
    }

    pub(crate) fn allows_node_head_generic(self, name: &str) -> bool {
        match self {
            Self::BuiltinGp => name == "node",
            Self::Loaded(rules) => rules
                .generic_admission
                .as_ref()
                .is_some_and(|admission| admission.node_head_datatypes.contains(name)),
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
                .as_ref()
                .is_some_and(|admission| admission.binding_node_reserved_arguments.contains(name)),
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

    pub(crate) fn allows_undeclared_literal_clarifier(self, name: &str) -> bool {
        match self {
            Self::BuiltinGp => true,
            Self::Loaded(rules) => !rules.closed_clarifiers && !is_reserved_datatype(name),
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
                let generic_kinds = rules
                    .generic_admission
                    .as_ref()
                    .filter(|admission| generic && admission.custom_labels)
                    .map(|admission| &admission.custom_value_kinds);
                if let Some(rule) = rules.datatype_semantics.get(datatype_base(datatype)) {
                    if rule.literal_family == kind
                        && generic_kinds.is_none_or(|kinds| kinds.contains(kind))
                    {
                        return None;
                    }
                    if generic_kinds.is_some_and(|kinds| !kinds.contains(&rule.literal_family)) {
                        "no literal family admitted by the profile".to_owned()
                    } else {
                        rule.literal_family.clone()
                    }
                } else {
                    let kinds = generic_kinds?;
                    if kinds.contains(kind) {
                        return None;
                    }
                    kinds
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
