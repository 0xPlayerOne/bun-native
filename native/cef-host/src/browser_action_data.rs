//! Bounded, engine-independent operation data. No CEF identities or payloads in diagnostics.
use crate::capability_policy::NativeRequest;
use serde::Deserialize;
use serde_json::{json, Value};

pub const MAX_PNG: usize = 1024 * 1024;
pub const MAX_JSON: usize = 256 * 1024;
pub const MAX_CALLBACK: usize = MAX_PNG.div_ceil(3) * 4 + 64;
pub const RESERVATION: usize = 3 * 1024 * 1024;
pub const MAX_WIDTH: u32 = 1024;
pub const MAX_HEIGHT: u32 = 768;
pub const WORLD_NAME: &str = "bunly.browser-actions";

/// A named isolated world can have contexts in multiple frames. Only the root
/// frame selected by this operation may supply its execution context identity.
pub fn created_context<'a>(
    value: &'a Value,
    main_frame: &str,
) -> Result<Option<(i64, &'a str)>, &'static str> {
    let Some(context) = value.get("context") else {
        return Ok(None);
    };
    if context.get("name").and_then(Value::as_str) != Some(WORLD_NAME) {
        return Ok(None);
    }
    let frame = context
        .get("auxData")
        .and_then(|data| data.get("frameId"))
        .and_then(Value::as_str)
        .filter(|frame| !frame.is_empty())
        .ok_or("adapter-error")?;
    if frame != main_frame {
        return Ok(None);
    }
    let id = context
        .get("id")
        .and_then(Value::as_i64)
        .filter(|id| *id > 0)
        .ok_or("adapter-error")?;
    let unique = context
        .get("uniqueId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .ok_or("unsupported-capability")?;
    Ok(Some((id, unique)))
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Action {
    Screenshot { width: u32, height: u32 },
    Evaluate { expression: String },
    Dom,
    Accessibility,
    Input { action: Input },
}
#[derive(Clone, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Input {
    Text { text: String },
    Pointer { x: f64, y: f64, button: Button },
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Button {
    Left,
    Right,
}
impl Action {
    pub fn decode(value: Value) -> Result<Self, &'static str> {
        let object = value
            .as_object()
            .ok_or("INVALID_ARGUMENT: browser action")?;
        let fields: &[&str] = match object.get("kind").and_then(Value::as_str) {
            Some("screenshot") => &["kind", "width", "height"],
            Some("evaluate") => &["kind", "expression"],
            Some("dom" | "accessibility") => &["kind"],
            Some("input") => &["kind", "action"],
            _ => return Err("UNSUPPORTED_CAPABILITY: browser action"),
        };
        if object.len() != fields.len() || object.keys().any(|key| !fields.contains(&key.as_str()))
        {
            return Err("INVALID_ARGUMENT: browser action fields");
        }
        let action: Self =
            serde_json::from_value(value).map_err(|_| "INVALID_ARGUMENT: browser action")?;
        action.validate()?;
        Ok(action)
    }
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Screenshot { width, height }
                if *width == 0 || *width > MAX_WIDTH || *height == 0 || *height > MAX_HEIGHT =>
            {
                Err("INVALID_ARGUMENT: screenshot bounds")
            }
            Self::Evaluate { expression }
                if expression.is_empty()
                    || expression.len() > 4096
                    || expression.contains('\0') =>
            {
                Err("INVALID_ARGUMENT: evaluation source")
            }
            Self::Input {
                action: Input::Text { text },
            } if text.len() > 4096 || text.contains('\0') => {
                Err("INVALID_ARGUMENT: synthetic input text")
            }
            Self::Input {
                action: Input::Pointer { x, y, .. },
            } if !x.is_finite()
                || !y.is_finite()
                || *x < 0.0
                || *y < 0.0
                || *x > MAX_WIDTH as f64
                || *y > MAX_HEIGHT as f64 =>
            {
                Err("INVALID_ARGUMENT: synthetic pointer")
            }
            _ => Ok(()),
        }
    }
    pub fn request(&self) -> NativeRequest {
        match self {
            Self::Screenshot { .. } => NativeRequest::BrowserSnapshot,
            Self::Evaluate { expression } => NativeRequest::BrowserEvaluate {
                expression: expression.clone(),
            },
            Self::Dom => NativeRequest::BrowserObserveDom,
            Self::Accessibility => NativeRequest::BrowserObserveAccessibility,
            Self::Input { .. } => NativeRequest::BrowserInput,
        }
    }
    pub fn expression(&self) -> Option<String> {
        match self {
            Self::Evaluate { expression } => Some(format!(
                "({EVALUATE})({})",
                serde_json::to_string(expression).unwrap()
            )),
            Self::Dom => Some(format!("({DOM})()")),
            Self::Input { action } => {
                let value = match action {
                    Input::Text { text } => json!({"type":"text", "text":text}),
                    Input::Pointer { x, y, button } => {
                        json!({"type":"pointer", "x":x, "y":y, "button":if matches!(button, Button::Right) {2} else {0}})
                    }
                };
                Some(format!("({INPUT})({value})"))
            }
            _ => None,
        }
    }
}

/// Reject allocation-amplifying shapes before serde allocates maps, arrays or strings.
/// Strings are scanned as borrowed bytes; escaped quotes do not affect depth.
pub fn bounded_json(raw: &[u8]) -> Result<Value, &'static str> {
    if raw.len() > MAX_JSON {
        return Err("payload-too-large");
    }
    let (mut depth, mut tokens, mut quoted, mut escaped, mut string_bytes) =
        (0_usize, 0_usize, false, false, 0_usize);
    for byte in raw {
        if quoted {
            string_bytes += 1;
            if string_bytes > MAX_JSON {
                return Err("payload-too-large");
            }
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => {
                    quoted = true;
                    tokens += 1;
                }
                b'{' | b'[' => {
                    depth += 1;
                    tokens += 1;
                }
                b'}' | b']' => depth = depth.saturating_sub(1),
                b',' | b':' => tokens += 1,
                _ => {}
            }
            if depth > 20 || tokens > 8192 {
                return Err("payload-too-large");
            }
        }
    }
    serde_json::from_slice(raw).map_err(|_| "adapter-error")
}

pub fn evaluation_bytes(raw: &[u8]) -> Result<Vec<u8>, &'static str> {
    let value = bounded_json(raw)?;
    if value.get("exceptionDetails").is_some() {
        return Err("adapter-error");
    }
    let result = value.get("result").ok_or("adapter-error")?;
    if result.get("type").and_then(Value::as_str) != Some("string") {
        return Err("unsupported-capability");
    }
    let text = result
        .get("value")
        .and_then(Value::as_str)
        .ok_or("adapter-error")?;
    if text.len() > MAX_JSON {
        return Err("payload-too-large");
    }
    let payload = bounded_json(text.as_bytes())?;
    if let Some(error) = payload.get("error").and_then(Value::as_str) {
        return Err(match error {
            "payload-too-large" => "payload-too-large",
            _ => "unsupported-capability",
        });
    }
    Ok(text.as_bytes().to_vec())
}

fn base64_digit(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}
pub fn screenshot_bytes(
    raw: &[u8],
    max_width: u32,
    max_height: u32,
) -> Result<(Vec<u8>, u32, u32), &'static str> {
    if raw.len() > MAX_CALLBACK {
        return Err("payload-too-large");
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Screenshot<'a> {
        data: &'a str,
    }
    // A borrowed string rejects JSON escapes, avoiding an intermediate base64 copy.
    let result: Screenshot<'_> = serde_json::from_slice(raw).map_err(|_| "adapter-error")?;
    let source = result.data.as_bytes();
    if source.is_empty() || !source.len().is_multiple_of(4) {
        return Err("adapter-error");
    }
    let padding = usize::from(source.last() == Some(&b'='))
        + usize::from(source.get(source.len() - 2) == Some(&b'='));
    let decoded = source.len() / 4 * 3 - padding;
    if decoded > MAX_PNG {
        return Err("payload-too-large");
    }
    let mut output = Vec::with_capacity(decoded);
    for (index, chunk) in source.chunks_exact(4).enumerate() {
        let last = index == source.len() / 4 - 1;
        let a = base64_digit(chunk[0]).ok_or("adapter-error")?;
        let b = base64_digit(chunk[1]).ok_or("adapter-error")?;
        let c = if chunk[2] == b'=' && last && padding == 2 {
            0
        } else {
            base64_digit(chunk[2]).ok_or("adapter-error")?
        };
        let d = if chunk[3] == b'=' && last && padding > 0 {
            0
        } else {
            base64_digit(chunk[3]).ok_or("adapter-error")?
        };
        if last && ((padding == 2 && b & 15 != 0) || (padding == 1 && c & 3 != 0)) {
            return Err("adapter-error");
        }
        output.push((a << 2) | (b >> 4));
        if !last || padding < 2 {
            output.push((b << 4) | (c >> 2));
        }
        if !last || padding == 0 {
            output.push((c << 6) | d);
        }
    }
    if output.len() < 57
        || output.get(8..12) != Some(&13_u32.to_be_bytes())
        || output.get(output.len().saturating_sub(12)..) != Some(b"\0\0\0\0IEND\xaeB`\x82")
        || output.get(..8) != Some(b"\x89PNG\r\n\x1a\n")
        || output.get(12..16) != Some(b"IHDR")
    {
        return Err("adapter-error");
    }
    let width = u32::from_be_bytes(output[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(output[20..24].try_into().unwrap());
    if width == 0 || height == 0 || width > max_width || height > max_height {
        return Err("payload-too-large");
    }
    Ok((output, width, height))
}

pub const METRICS: &str =
    "JSON.stringify({width:innerWidth,height:innerHeight,scale:devicePixelRatio})";
const EVALUATE: &str = r#"function(source) {
  const bad = code => JSON.stringify({error:code});
  const value = (0,eval)(source);
  if (value === undefined) return JSON.stringify({defined:false});
  let nodes = 0;
  const seen = new Set();
  function check(v, depth) {
    if (++nodes > 256 || depth > 4) throw 0;
    if (typeof v === 'string') { let n = 0; for (const _ of v) if (++n > 512) throw 0; return; }
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return;
    if (typeof v !== 'object' || seen.has(v) || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype)) throw 0;
    seen.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    for (const key of Object.keys(descriptors)) {
      if (Array.isArray(v) && key === 'length') continue;
      if (key.length > 512 || !('value' in descriptors[key])) throw 0;
      check(descriptors[key].value, depth + 1);
    }
  }
  try { check(value, 0); const output = JSON.stringify({defined:true,value}); return new TextEncoder().encode(output).length <= 262144 ? output : bad('payload-too-large'); }
  catch { return bad('payload-too-large'); }
}"#;
const DOM: &str = r#"function() {
  const nodes = []; let truncated = false;
  const text = value => { let s = '', n = 0; for (const c of String(value ?? '')) { if (++n > 512) { truncated = true; break; } s += c; } return s; };
  function visit(element, parent, depth) {
    if (nodes.length >= 256) { truncated = true; return; }
    const id = nodes.length + 1;
    let content = ''; let inspected = 0;
    for (let child = element.firstChild; child && inspected++ < 256; child = child.nextSibling) {
      if (child.nodeType === 3 && content.length < 1024) content += text(child.nodeValue);
    }
    const tag = element.localName;
    nodes.push({id,...(parent === undefined ? {} : {parent}),depth,role:text(element.getAttribute('role') || tag),name:text(element.getAttribute('aria-label') || element.getAttribute('title') || ''),text:text(content)});
    if (['iframe','frame','object','embed','script','style'].includes(tag)) return;
    if (depth === 4) { if (element.firstElementChild) truncated = true; return; }
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
      if (nodes.length >= 256) { truncated = true; break; }
      visit(child, id, depth + 1);
    }
  }
  if (!document.documentElement) return JSON.stringify({error:'unsupported-capability'});
  visit(document.documentElement, undefined, 0);
  const output = JSON.stringify({kind:'dom',nodes,truncated});
  return new TextEncoder().encode(output).length <= 262144 ? output : JSON.stringify({error:'payload-too-large'});
}"#;
const INPUT: &str = r#"function(action) {
  const denied = () => JSON.stringify({error:'unsupported-capability'});
  const forbidden = target => !target || target.ownerDocument !== document || !target.isConnected || ['iframe','frame','object','embed'].includes(target.localName);
  if (action.type === 'text') {
    const target = document.activeElement;
    if (forbidden(target) || target.disabled || target.readOnly || target.type === 'password') return denied();
    if (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement && ['text','search','url','tel'].includes(target.type))) return denied();
    if (!target.dispatchEvent(new InputEvent('beforeinput',{bubbles:true,cancelable:true,inputType:'insertText',data:action.text}))) return denied();
    if (document.activeElement !== target || forbidden(target) || target.disabled || target.readOnly || target.type === 'password' || (!(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLInputElement && ['text','search','url','tel'].includes(target.type)))) return denied();
    try { target.setRangeText(action.text, target.selectionStart ?? target.value.length, target.selectionEnd ?? target.value.length, 'end'); }
    catch { return denied(); }
    target.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:action.text}));
  } else {
    if (action.x >= innerWidth || action.y >= innerHeight) return denied();
    const target = document.elementFromPoint(action.x, action.y);
    if (forbidden(target)) return denied();
    for (const type of ['mousedown','mouseup',action.button === 2 ? 'contextmenu' : 'click']) {
      if (forbidden(target) || document.elementFromPoint(action.x, action.y) !== target) return denied();
      target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,clientX:action.x,clientY:action.y,button:action.button}));
    }
  }
  return JSON.stringify({accepted:true,synthetic:true});
}"#;

#[cfg(test)]
mod tests {
    use super::*;
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=";
    #[test]
    fn named_child_context_never_binds_or_invalidates_the_root_context() {
        let child = json!({"context":{
            "name":WORLD_NAME,"id":2,"uniqueId":"child-context",
            "auxData":{"frameId":"child-frame"}
        }});
        let root = json!({"context":{
            "name":WORLD_NAME,"id":1,"uniqueId":"root-context",
            "auxData":{"frameId":"root-frame"}
        }});
        // Runtime.enable may replay child contexts before the main one, and
        // touching a child WindowProxy can create one during a main-frame call.
        assert_eq!(created_context(&child, "root-frame"), Ok(None));
        assert_eq!(
            created_context(&root, "root-frame"),
            Ok(Some((1, "root-context")))
        );
        assert_eq!(created_context(&child, "root-frame"), Ok(None));
        assert_eq!(created_context(&root, "child-frame"), Ok(None));
    }
    #[test]
    fn root_context_binding_requires_the_exact_world_and_bounded_identity() {
        let root = json!({"context":{
            "name":WORLD_NAME,"id":1,"uniqueId":"root-context",
            "auxData":{"frameId":"root-frame"}
        }});
        let mut unrelated = root.clone();
        unrelated["context"]["name"] = json!("another-world");
        assert_eq!(created_context(&unrelated, "root-frame"), Ok(None));
        for id in [json!(null), json!(0), json!(-1), json!(1.5), json!("1")] {
            let mut malformed = root.clone();
            malformed["context"]["id"] = id;
            assert_eq!(
                created_context(&malformed, "root-frame"),
                Err("adapter-error")
            );
        }
        for unique in [json!(null), json!(""), json!("x".repeat(257)), json!(1)] {
            let mut malformed = root.clone();
            malformed["context"]["uniqueId"] = unique;
            assert_eq!(
                created_context(&malformed, "root-frame"),
                Err("unsupported-capability")
            );
        }
    }
    #[test]
    fn missing_frame_identity_cannot_be_treated_as_an_unrelated_context() {
        for frame in [json!(null), json!(""), json!(1)] {
            let value = json!({"context":{
                "name":WORLD_NAME,"id":1,"uniqueId":"root-context",
                "auxData":{"frameId":frame}
            }});
            assert_eq!(created_context(&value, "root-frame"), Err("adapter-error"));
        }
        let foreign = json!({"context":{
            "name":WORLD_NAME,"auxData":{"frameId":"child-frame"}
        }});
        assert_eq!(created_context(&foreign, "root-frame"), Ok(None));
    }
    #[test]
    fn png_transfer_owns_decoded_bytes_and_verifies_dimensions() {
        let raw = format!("{{\"data\":\"{PNG}\"}}");
        let (bytes, width, height) = screenshot_bytes(raw.as_bytes(), 32, 32).unwrap();
        assert_eq!((width, height), (1, 1));
        assert_eq!(bytes.len(), 68);
        assert_eq!(
            screenshot_bytes(raw.as_bytes(), 0, 1).unwrap_err(),
            "payload-too-large"
        );
    }
    #[test]
    fn screenshot_rejects_oversize_before_base64_copy() {
        assert_eq!(
            screenshot_bytes(&vec![b'a'; MAX_CALLBACK + 1], 1024, 768).unwrap_err(),
            "payload-too-large"
        );
        let encoded = "AAAA".repeat(MAX_PNG / 3 + 1);
        let raw = format!("{{\"data\":\"{encoded}\"}}");
        assert_eq!(
            screenshot_bytes(raw.as_bytes(), 1024, 768).unwrap_err(),
            "payload-too-large"
        );
    }
    #[test]
    fn screenshot_rejects_escapes_padding_noncanonical_bits_and_extra_fields() {
        for raw in [
            "{\"data\":\"\\u0041AAA\"}",
            "{\"data\":\"AB==\"}",
            "{\"data\":\"A===\"}",
            "{\"data\":\"AAA\"}",
            "{\"data\":\"AAAA\",\"extra\":1}",
        ] {
            assert!(screenshot_bytes(raw.as_bytes(), 1024, 768).is_err());
        }
    }
    #[test]
    fn parser_bounds_raw_bytes_depth_and_allocation_amplifying_shapes() {
        assert_eq!(
            bounded_json(&vec![b' '; MAX_JSON + 1]).unwrap_err(),
            "payload-too-large"
        );
        let deep = format!("{}0{}", "[".repeat(21), "]".repeat(21));
        assert_eq!(
            bounded_json(deep.as_bytes()).unwrap_err(),
            "payload-too-large"
        );
        let wide = format!("[{}0]", "0,".repeat(8192));
        assert_eq!(
            bounded_json(wide.as_bytes()).unwrap_err(),
            "payload-too-large"
        );
        assert_eq!(
            bounded_json(br#"{"text":"[[[\\\""}"#).unwrap()["text"],
            "[[[\\\""
        );
    }
    #[test]
    fn evaluation_never_forwards_raw_exception_or_protocol_error_text() {
        assert_eq!(
            evaluation_bytes(br#"{"exceptionDetails":{"text":"secret"},"result":{}}"#).unwrap_err(),
            "adapter-error"
        );
        assert_eq!(
            evaluation_bytes(br#"{"result":{"type":"object","subtype":"promise"}}"#).unwrap_err(),
            "unsupported-capability"
        );
        assert_eq!(
            evaluation_bytes(br#"{"result":{"type":"string","value":"{\"error\":\"secret\"}"}}"#)
                .unwrap_err(),
            "unsupported-capability"
        );
    }
    #[test]
    fn observation_and_input_never_accept_caller_supplied_frame_or_context_ids() {
        assert!(Action::decode(json!({"kind":"dom","frameId":"foreign"})).is_err());
        assert!(Action::decode(
            json!({"kind":"evaluate","expression":"document.title","uniqueContextId":"forged"})
        )
        .is_err());
        assert!(Action::decode(
            json!({"kind":"input","action":{"type":"text","text":"value","target":"iframe"}})
        )
        .is_err());
        assert!(Action::decode(json!({"kind":"accessibility"})).is_ok());
    }
    #[test]
    fn exact_evaluation_source_and_synthetic_input_bounds_precede_dispatch() {
        let action = Action::Evaluate {
            expression: "document.title".into(),
        };
        assert_eq!(
            action.request(),
            NativeRequest::BrowserEvaluate {
                expression: "document.title".into()
            }
        );
        assert!(Action::Evaluate {
            expression: "é".repeat(2049)
        }
        .validate()
        .is_err());
        assert!(Action::Input {
            action: Input::Text {
                text: "😀".repeat(1025)
            }
        }
        .validate()
        .is_err());
        assert!(Action::Input {
            action: Input::Pointer {
                x: f64::NAN,
                y: 0.0,
                button: Button::Left
            }
        }
        .validate()
        .is_err());
        assert!(Action::Screenshot {
            width: 1025,
            height: 1
        }
        .validate()
        .is_err());
    }
}
