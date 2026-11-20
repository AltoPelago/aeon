use aeon_aeos::{
    Schema, ValidationEnvelope, ValidationOptions, validate, validate_telex, validate_telex_records,
};
use aes_telex::{TelexLimits, TelexRecord, encode_telex};
use serde_json::{Value, json};
use std::io::{self, BufRead};

fn evaluate(request: &Value) -> Result<Value, &'static str> {
    let schema: Schema = serde_json::from_value(request["schema"].clone()).map_err(|_| "schema")?;
    let options: ValidationOptions =
        serde_json::from_value(request.get("options").cloned().unwrap_or_else(|| json!({})))
            .map_err(|_| "options")?;
    let result = if request["entrypoint"] == "legacy" {
        validate(&ValidationEnvelope {
            aes: vec![],
            schema: Some(schema),
            options,
        })
    } else if request["entrypoint"] == "portable" {
        let records = request["records"]
            .as_array()
            .ok_or("records")?
            .iter()
            .map(|record| {
                let fields = record
                    .as_object()
                    .ok_or("record")?
                    .iter()
                    .map(|(key, value)| {
                        Ok((key.clone(), value.as_str().ok_or("field")?.to_owned()))
                    })
                    .collect::<Result<Vec<_>, &'static str>>()?;
                Ok(TelexRecord::new(fields))
            })
            .collect::<Result<Vec<_>, &'static str>>()?;
        match request["representation"].as_str() {
            Some("records") => validate_telex_records(&records, Some(schema), options),
            Some("telex") => validate_telex(
                &encode_telex(&records, None).map_err(|_| "encode")?,
                schema,
                options,
                &TelexLimits::default(),
                &[],
            ),
            _ => return Err("representation"),
        }
    } else {
        return Err("entrypoint");
    };
    Ok(json!({"result":result,"inputUnchanged":true}))
}

fn main() {
    let mut failed = false;
    for line in io::stdin().lock().lines() {
        let reply = line
            .map_err(|_| "read")
            .and_then(|line| serde_json::from_str::<Value>(&line).map_err(|_| "json"))
            .and_then(|request| evaluate(&request));
        match reply {
            Ok(value) => println!("{value}"),
            Err(_) => {
                println!("{}", json!({"error":"adapter_failure"}));
                failed = true;
            }
        }
    }
    if failed {
        std::process::exit(1);
    }
}
