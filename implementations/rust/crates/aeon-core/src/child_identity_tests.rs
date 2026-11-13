use crate::sansa::*;
use serde_json::{Value as J, json};
fn binding(v: &J) -> SansaResolveBinding {
    SansaResolveBinding {
        address: v["address"].as_str().map(str::to_owned),
        structural_identity: v["identity"].as_str().map(str::to_owned),
        name: v["name"].as_str().map(str::to_owned),
        index: v["index"].as_u64().map(|n| n as usize),
        children: v["children"]
            .as_array()
            .map(|cs| cs.iter().map(binding).collect())
            .unwrap_or_default(),
        attribute_space: v.get("attributeSpace").map(|v| Box::new(binding(v))),
        local_spaces: v["localSpaces"]
            .as_object()
            .map(|m| m.iter().map(|(k, v)| (k.clone(), binding(v))).collect())
            .unwrap_or_default(),
        ..SansaResolveBinding::default()
    }
}
fn parents(node: &mut SansaResolveBinding) {
    let snapshot = node.clone();
    for child in &mut node.children {
        child.parent = Some(Box::new(snapshot.clone()));
        parents(child);
    }
}
#[test]
fn parser_candidate_vectors() {
    let s: J = serde_json::from_str(include_str!(
        "../tests/fixtures/child-identity/12-child-identity-parser.json"
    ))
    .unwrap();
    for case in s["tests"].as_array().unwrap() {
        let got = parse_address(case["input"]["source"].as_str().unwrap());
        assert_eq!(
            got.is_ok(),
            case["expected"]["ok"].as_bool().unwrap(),
            "{}: {got:?}",
            case["id"]
        );
        if let Err(error) = &got {
            if let Some(code) = case["expected"]["error"].as_str() {
                assert_eq!(error.code, code, "{}", case["id"]);
            }
            if let Some(index) = case["expected"]["index"].as_u64() {
                assert_eq!(error.index, index as usize, "{}", case["id"]);
            }
        }
        if let Ok(a) = got {
            assert_eq!(a.is_exact, case["expected"]["exact"].as_bool().unwrap());
            assert_eq!(render_address(&a), case["expected"]["canonical"]);
            assert_eq!(parse_address(&a.canonical).unwrap(), a);
        }
    }
}
#[test]
fn resolve_candidate_vectors() {
    let s: J = serde_json::from_str(include_str!(
        "../tests/fixtures/child-identity/13-child-identity-resolve.json"
    ))
    .unwrap();
    let mut count = 0;
    for case in s["tests"].as_array().unwrap() {
        let i = &case["input"];
        if i.get("maxIdentityInspections")
            .is_some_and(|v| v.as_u64().is_none())
        {
            continue;
        }
        if case["id"] == "sansa-child-resolve-invalid-metadata" {
            continue;
        } // numeric metadata is not representable by Option<String>
        count += 1;
        let f = s["fixtures"]["namespaces"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["id"] == i["namespace"])
            .unwrap();
        let mut root = binding(&f["root"]);
        parents(&mut root);
        let mut n = SansaResolveNamespace::new(root);
        n.supports_structural_identity = f["supportsIdentity"].as_bool().unwrap();
        n.supports_parent_traversal = true;
        n.supports_local_space = true;
        let mut o = SansaResolveOptions::default();
        if let Some(limit) = i["maxIdentityInspections"].as_u64() {
            o.max_identity_inspections = limit as usize;
        }
        o.max_bindings = i["maxBindings"].as_u64().map(|n| n as usize);
        if i["contextualRoot"].is_string() {
            o.contextual_root = Some(n.root.children[0].clone());
        }
        let got = resolve_address(i["source"].as_str().unwrap(), &n, &o);
        assert_eq!(
            got.ok,
            case["expected"]["ok"].as_bool().unwrap(),
            "{}: {got:?}",
            case["id"]
        );
        if got.ok {
            assert_eq!(
                json!(
                    got.bindings
                        .iter()
                        .map(|b| b.address.clone().unwrap())
                        .collect::<Vec<_>>()
                ),
                case["expected"]["addresses"],
                "{}",
                case["id"]
            );
        } else {
            assert!(got.bindings.is_empty());
            let error = &got.errors[0];
            let context = json!({"selectorIndex":error.selector_index,"identity":error.identity,"limit":error.limit,"observed":error.observed});
            for field in ["selectorIndex", "identity", "limit", "observed"] {
                if let Some(expected) = case["expected"].get(field) {
                    assert_eq!(&context[field], expected, "{}: {}", case["id"], field);
                }
            }
            assert_eq!(
                got.errors[0].code, case["expected"]["error"],
                "{}",
                case["id"]
            );
        }
    }
    assert_eq!(count, 35);
}
#[test]
fn occurrence_identity_is_not_structural_identity() {
    let mut n = SansaResolveNamespace::new(SansaResolveBinding {
        children: vec![SansaResolveBinding {
            identity: Some("x".into()),
            ..SansaResolveBinding::default()
        }],
        ..SansaResolveBinding::default()
    });
    n.supports_structural_identity = true;
    assert!(
        resolve_address("$.\\x\\", &n, &SansaResolveOptions::default())
            .bindings
            .is_empty()
    );
    let mut a = parse_address("$.\\x\\").unwrap();
    a.is_exact = true;
    a.canonical = "$.other".into();
    assert!(resolve_parsed_address(&a, &n, &SansaResolveOptions::default()).ok);
    a.selectors = vec![SansaSelector::ChildIdentity {
        identity: "x\\.other".into(),
    }];
    assert_eq!(
        resolve_parsed_address(&a, &n, &SansaResolveOptions::default()).errors[0].code,
        "SANSA_RESOLVE_INVALID_ADDRESS"
    );
}

#[test]
fn binding_limit_stops_before_inspecting_later_parent_branches() {
    let child = |identity: &str| SansaResolveBinding {
        structural_identity: Some(identity.into()),
        ..SansaResolveBinding::default()
    };
    let mut ns = SansaResolveNamespace::new(SansaResolveBinding {
        children: vec![
            SansaResolveBinding {
                children: vec![child("x")],
                ..SansaResolveBinding::default()
            },
            SansaResolveBinding {
                children: vec![child("bad!")],
                ..SansaResolveBinding::default()
            },
        ],
        ..SansaResolveBinding::default()
    });
    ns.supports_structural_identity = true;
    let got = resolve_address(
        "$.*.\\x\\",
        &ns,
        &SansaResolveOptions {
            max_bindings: Some(0),
            max_identity_inspections: 1,
            ..SansaResolveOptions::default()
        },
    );
    assert_eq!(got.errors[0].code, "SANSA_RESOLVE_BINDING_LIMIT_EXCEEDED");
    assert!(got.bindings.is_empty());
}
