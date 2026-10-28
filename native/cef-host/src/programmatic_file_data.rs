//! Bounded trusted-byte staging. No filesystem paths, page script, or CEF handles.
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const MAX_FILE: usize = 1024 * 1024;
pub const CHUNK: usize = 8192;
pub const OVERHEAD: usize = 256 * 1024;
pub const WORLD: &str = "bunly.programmatic-files";
pub const MAX_CALLBACK: usize = 16 * 1024;

/// Runtime events cover multiple frames. A context in another frame, even with
/// our world name, cannot supply or replace the captured main-frame identity.
pub fn created_context<'a>(
    value: &'a Value,
    main_frame: &str,
) -> Result<Option<(i64, &'a str)>, &'static str> {
    let Some(context) = value.get("context") else {
        return Ok(None);
    };
    if context.get("name").and_then(Value::as_str) != Some(WORLD) {
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

/// An operation incarnation owns every callback and private object until both
/// cleanup acknowledgements, or its exact browser's real close callback. Merely
/// allowing the close path to proceed never retires this owner.
pub struct Ownership {
    pub operation: u64,
    pub browser: i32,
    awaiting_close: bool,
    group_released: bool,
    runtime_disabled: bool,
}
impl Ownership {
    pub fn new(operation: u64, browser: i32) -> Self {
        Self {
            operation,
            browser,
            awaiting_close: false,
            group_released: false,
            runtime_disabled: false,
        }
    }
    pub fn matches(&self, operation: u64, browser: i32) -> bool {
        self.operation == operation && self.browser == browser
    }
    /// The first transition requests one deferred close continuation. The owner
    /// remains present and charged until an actual matching close receipt.
    pub fn await_close(&mut self) -> bool {
        !std::mem::replace(&mut self.awaiting_close, true)
    }
    pub fn blocks_close(&self) -> bool {
        !self.awaiting_close
    }
    pub fn group_released(&self) -> bool {
        self.group_released
    }
    pub fn acknowledge_group(&mut self) {
        self.group_released = true;
    }
    pub fn acknowledge_disabled(&mut self) -> bool {
        if !self.group_released {
            return false;
        }
        self.runtime_disabled = true;
        true
    }
    pub fn can_release(&self, operation: u64, closed_browser: Option<i32>) -> bool {
        self.operation == operation
            && match closed_browser {
                Some(browser) => browser == self.browser,
                None => !self.awaiting_close && self.group_released && self.runtime_disabled,
            }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    FileInput,
    FileDrop,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Metadata {
    pub kind: Kind,
    pub element_id: String,
    pub name: String,
    pub mime: String,
    pub bytes: usize,
    pub sha256: String,
}
pub fn element_id(value: &str) -> bool {
    crate::capability_policy::file_element_id(value)
}
fn file_name(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 128
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || value.ends_with('.')
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        return false;
    }
    let base = value.split('.').next().unwrap().to_ascii_lowercase();
    !matches!(base.as_str(), "con" | "prn" | "aux" | "nul")
        && !(base.len() == 4
            && (base.starts_with("com") || base.starts_with("lpt"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'))
}
fn mime(value: &str) -> bool {
    let Some((left, right)) = value.split_once('/') else {
        return false;
    };
    let token = |part: &str| {
        !part.is_empty()
            && part.as_bytes()[0].is_ascii_alphanumeric()
            && part
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"!#$&^_.+-".contains(&c))
    };
    value.len() <= 127 && token(left) && token(right)
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
impl Metadata {
    pub fn decode(value: &Value) -> Result<Self, &'static str> {
        let object = value.as_object().ok_or("INVALID_ARGUMENT: file metadata")?;
        if object.len() != 6
            || !["kind", "elementId", "name", "mime", "bytes", "sha256"]
                .iter()
                .all(|k| object.contains_key(*k))
            || !matches!(
                value.get("kind").and_then(Value::as_str),
                Some("file-input" | "file-drop")
            )
            || !value
                .get("elementId")
                .and_then(Value::as_str)
                .is_some_and(element_id)
            || !value
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(file_name)
            || !value.get("mime").and_then(Value::as_str).is_some_and(mime)
            || !value
                .get("sha256")
                .and_then(Value::as_str)
                .is_some_and(digest)
            || value
                .get("bytes")
                .and_then(Value::as_u64)
                .is_none_or(|n| n > MAX_FILE as u64)
        {
            return Err("INVALID_ARGUMENT: file metadata");
        }
        // Only bounded metadata is cloned. File bytes arrive separately under admission.
        serde_json::from_value(value.clone()).map_err(|_| "INVALID_ARGUMENT: file metadata")
    }
    pub fn reservation(&self) -> usize {
        2 * self.bytes + OVERHEAD
    }
    pub fn preparation(&self, url: &str) -> String {
        format!(
            "({PREPARE})({})",
            json!({
                "kind":if self.kind == Kind::FileInput {"file-input"} else {"file-drop"},
                "elementId":self.element_id,"name":self.name,"mime":self.mime,"bytes":self.bytes,"url":url,
            })
        )
    }
}

pub struct Transfer {
    received: usize,
    hash: Sha256,
}
impl Default for Transfer {
    fn default() -> Self {
        Self {
            received: 0,
            hash: Sha256::new(),
        }
    }
}
impl Transfer {
    pub fn received(&self) -> usize {
        self.received
    }
    pub fn chunk(
        &self,
        metadata: &Metadata,
        offset: u64,
        hex: &str,
    ) -> Result<Vec<u8>, &'static str> {
        if offset != self.received as u64
            || hex.is_empty()
            || hex.len() > 2 * CHUNK
            || !hex.len().is_multiple_of(2)
            || hex.len() / 2 > metadata.bytes.saturating_sub(self.received)
            || !hex
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err("INVALID_ARGUMENT: file chunk");
        }
        let digit = |c: u8| if c <= b'9' { c - b'0' } else { c - b'a' + 10 };
        Ok(hex
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| digit(pair[0]) * 16 + digit(pair[1]))
            .collect())
    }
    pub fn acknowledged(&mut self, bytes: &[u8]) {
        self.hash.update(bytes);
        self.received += bytes.len();
    }
    pub fn complete(&self, metadata: &Metadata) -> bool {
        self.received == metadata.bytes
            && format!("{:x}", self.hash.clone().finalize()) == metadata.sha256
    }
}
pub fn encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(HEX[(byte >> 4) as usize] as char);
        value.push(HEX[(byte & 15) as usize] as char);
    }
    value
}

pub fn callback(raw: &[u8]) -> Result<Value, &'static str> {
    if raw.len() > MAX_CALLBACK {
        return Err("payload-too-large");
    }
    let (mut depth, mut tokens, mut quoted, mut escaped) = (0_usize, 0_usize, false, false);
    for c in raw {
        if quoted {
            if escaped {
                escaped = false;
            } else if *c == b'\\' {
                escaped = true;
            } else if *c == b'"' {
                quoted = false;
            }
        } else {
            match c {
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
            if depth > 16 || tokens > 2048 {
                return Err("payload-too-large");
            }
        }
    }
    serde_json::from_slice(raw).map_err(|_| "adapter-error")
}
pub fn controller(raw: &[u8]) -> Result<String, &'static str> {
    let value = callback(raw)?;
    if value.get("exceptionDetails").is_some() {
        return Err("unsupported-capability");
    }
    let result = value.get("result").ok_or("adapter-error")?;
    if result.get("type").and_then(Value::as_str) != Some("object") {
        return Err("adapter-error");
    }
    result
        .get("objectId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .map(str::to_owned)
        .ok_or("adapter-error")
}
pub fn acknowledged(raw: &[u8]) -> Result<(), &'static str> {
    if !callback(raw)?
        .as_object()
        .is_some_and(|value| value.is_empty())
    {
        return Err("adapter-error");
    }
    Ok(())
}
pub fn confirmed(raw: &[u8]) -> Result<(), &'static str> {
    let value = callback(raw)?;
    if value.get("exceptionDetails").is_some() {
        return Err("adapter-error");
    }
    let result = value.get("result").ok_or("adapter-error")?;
    if result.get("type").and_then(Value::as_str) != Some("boolean")
        || result.get("value") != Some(&Value::Bool(true))
    {
        return Err("stale-target");
    }
    Ok(())
}
pub const WRITE: &str = "function(offset,hex){return this.write(offset,hex)}";
pub const COMMIT: &str = "function(){return this.commit()}";
pub const CLEAR: &str = "function(){return this.clear()}";
// The controller has no global binding. Its only root is the native object group.
// Fixed function declarations above cannot execute caller-supplied page source.
const PREPARE: &str = r#"function(meta) {
  const docURL = Object.getOwnPropertyDescriptor(Document.prototype,'URL').get;
  const connected = Object.getOwnPropertyDescriptor(Node.prototype,'isConnected').get;
  const owner = Object.getOwnPropertyDescriptor(Node.prototype,'ownerDocument').get;
  const select = Document.prototype.querySelectorAll;
  const item = NodeList.prototype.item;
  const length = Object.getOwnPropertyDescriptor(NodeList.prototype,'length').get;
  const inputType = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'type').get;
  const disabled = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'disabled').get;
  const files = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'files').set;
  const attr = Element.prototype.hasAttribute;
  const localName = Object.getOwnPropertyDescriptor(Element.prototype,'localName').get;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const FileClass = File, TransferClass = DataTransfer, EventClass = Event, DragClass = DragEvent;
  const getItems = Object.getOwnPropertyDescriptor(DataTransfer.prototype,'items').get;
  const getFiles = Object.getOwnPropertyDescriptor(DataTransfer.prototype,'files').get;
  const add = DataTransferItemList.prototype.add;
  let doc = document, target = null, data = new Uint8Array(meta.bytes), cursor = 0, active = true, committed = false;
  const selected = () => { const list = select.call(doc,'#'+meta.elementId); return length.call(list) === 1 ? item.call(list,0) : null; };
  target = selected();
  const live = () => active && doc === document && docURL.call(doc) === meta.url && target &&
    connected.call(target) && owner.call(target) === doc && selected() === target &&
    !['iframe','frame','object','embed'].includes(localName.call(target)) &&
    (meta.kind !== 'file-input' || (target instanceof HTMLInputElement && inputType.call(target) === 'file' && !disabled.call(target) && !attr.call(target,'webkitdirectory')));
  if (!live()) throw new Error('BUNLY_FILE_TARGET_UNAVAILABLE');
  return Object.freeze({
    write(offset,hex) {
      if (!live() || committed || offset !== cursor || !hex.length || hex.length > 16384 || hex.length % 2 || cursor + hex.length/2 > data.length) return false;
      for (let i=0;i<hex.length;i+=2) data[cursor++] = parseInt(hex.slice(i,i+2),16);
      return true;
    },
    commit() {
      if (!live() || committed || cursor !== data.length) return false;
      committed = true;
      const transfer = new TransferClass();
      add.call(getItems.call(transfer),new FileClass([data],meta.name,{type:meta.mime,lastModified:0}));
      if (meta.kind === 'file-input') {
        files.call(target,getFiles.call(transfer));
        for (const type of ['input','change']) {
          if (!live()) return false;
          dispatch.call(target,new EventClass(type,{bubbles:true,composed:true}));
        }
      } else {
        for (const type of ['dragenter','dragover','drop']) {
          if (!live()) return false;
          dispatch.call(target,new DragClass(type,{bubbles:true,cancelable:true,composed:true,dataTransfer:transfer}));
        }
      }
      return true;
    },
    clear() { active = false; data = null; target = null; doc = null; cursor = 0; return true; }
  });
}"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_context_ignores_named_child_frames_before_and_after_main_binding() {
        let main = json!({"context":{
            "name":WORLD,"id":1,"uniqueId":"main-context",
            "auxData":{"frameId":"main-frame"}
        }});
        let child = json!({"context":{
            "name":WORLD,"id":2,"uniqueId":"child-context",
            "auxData":{"frameId":"child-frame"}
        }});
        assert_eq!(created_context(&child, "main-frame"), Ok(None));
        assert_eq!(
            created_context(&main, "main-frame"),
            Ok(Some((1, "main-context")))
        );
        assert_eq!(created_context(&child, "main-frame"), Ok(None));
        let browser_world = json!({"context":{
            "name":"bunly.browser-actions","id":1,"uniqueId":"browser-context",
            "auxData":{"frameId":"main-frame"}
        }});
        assert_eq!(created_context(&browser_world, "main-frame"), Ok(None));
    }
    #[test]
    fn file_context_requires_positive_and_bounded_main_identity() {
        let main = json!({"context":{
            "name":WORLD,"id":1,"uniqueId":"main-context",
            "auxData":{"frameId":"main-frame"}
        }});
        for id in [json!(null), json!(0), json!(-1), json!(1.5), json!("1")] {
            let mut malformed = main.clone();
            malformed["context"]["id"] = id;
            assert_eq!(
                created_context(&malformed, "main-frame"),
                Err("adapter-error")
            );
        }
        for unique in [json!(null), json!(""), json!("x".repeat(257)), json!(1)] {
            let mut malformed = main.clone();
            malformed["context"]["uniqueId"] = unique;
            assert_eq!(
                created_context(&malformed, "main-frame"),
                Err("unsupported-capability")
            );
        }
    }
    #[test]
    fn file_context_cannot_ignore_a_missing_frame_identity() {
        for frame in [json!(null), json!(""), json!(1)] {
            let value = json!({"context":{
                "name":WORLD,"id":1,"uniqueId":"main-context",
                "auxData":{"frameId":frame}
            }});
            assert_eq!(created_context(&value, "main-frame"), Err("adapter-error"));
        }
        let foreign = json!({"context":{
            "name":WORLD,"auxData":{"frameId":"child-frame"}
        }});
        assert_eq!(created_context(&foreign, "main-frame"), Ok(None));
    }

    #[test]
    fn detached_owner_allows_real_close_but_cannot_release_from_late_cleanup_or_old_incarnation() {
        let mut owner = Ownership::new(71, 19);
        assert!(owner.blocks_close());
        assert!(!owner.can_release(71, None));
        assert!(
            !owner.acknowledge_disabled(),
            "An out-of-order ACK cannot retire owners"
        );
        owner.acknowledge_group();
        assert!(
            !owner.can_release(71, None),
            "Runtime observer still owns callbacks"
        );
        assert!(
            owner.await_close(),
            "Resume an already parked close on transition"
        );
        assert!(
            !owner.await_close(),
            "Repeated detach callbacks cannot queue retries"
        );
        assert!(
            !owner.blocks_close(),
            "Actual destruction must remain possible"
        );
        assert!(!owner.can_release(71, None));
        assert!(owner.acknowledge_disabled());
        assert!(
            !owner.can_release(71, None),
            "A detached owner awaits actual OnBeforeClose"
        );
        assert!(!owner.can_release(70, Some(19)));
        assert!(!owner.can_release(71, Some(20)));
        assert!(owner.can_release(71, Some(19)));
        let replacement = Ownership::new(72, 19);
        assert!(!replacement.matches(71, 19));
        assert!(
            !replacement.can_release(71, Some(19)),
            "An old observer cannot release a replacement owner"
        );
        assert!(replacement.blocks_close());
    }

    #[test]
    fn normal_cleanup_requires_both_actual_acknowledgements_for_the_current_operation() {
        let mut owner = Ownership::new(31, 9);
        owner.acknowledge_group();
        assert!(!owner.can_release(31, None));
        assert!(owner.acknowledge_disabled());
        assert!(owner.can_release(31, None));
        assert!(!owner.can_release(30, None));
    }
    fn metadata(bytes: &[u8]) -> Metadata {
        Metadata::decode(&json!({"kind":"file-input","elementId":"upload","name":"file.bin","mime":"application/octet-stream","bytes":bytes.len(),"sha256":format!("{:x}",Sha256::digest(bytes))})).unwrap()
    }
    #[test]
    fn metadata_and_reservation_are_exact_and_bounded_before_bytes() {
        let full = metadata(&vec![1; MAX_FILE]);
        assert_eq!(full.reservation(), 2 * MAX_FILE + OVERHEAD);
        assert!(metadata(b"").bytes == 0);
        for name in ["../file", "CON.txt", "file.", "file\n", "file/path", "Ω"] {
            assert!(!file_name(name));
        }
        for mime_value in [
            "TEXT/plain",
            "text/plain\n",
            "text/plain;x=y",
            "text/",
            "/plain",
        ] {
            assert!(!mime(mime_value));
        }
        for id in ["#upload", "upload\n", "a b", "", "1upload"] {
            assert!(!element_id(id));
        }
        let valid = json!({"kind":"file-input","elementId":"upload","name":"file.bin","mime":"application/octet-stream","bytes":1,"sha256":"a".repeat(64)});
        for (key, value) in [
            ("path", json!("/unrelated")),
            ("bytes", json!(MAX_FILE + 1)),
            ("bytes", json!(-1)),
            ("kind", json!("picker")),
            ("sha256", json!("A".repeat(64))),
        ] {
            let mut bad = valid.clone();
            bad[key] = value;
            assert!(Metadata::decode(&bad).is_err());
        }
    }
    #[test]
    fn transfer_accepts_only_ordered_bounded_acknowledged_chunks_and_exact_hash() {
        let data = vec![7; CHUNK + 1];
        let metadata = metadata(&data);
        let mut transfer = Transfer::default();
        assert!(transfer.chunk(&metadata, 1, "07").is_err());
        assert!(transfer
            .chunk(&metadata, 0, &"07".repeat(CHUNK + 1))
            .is_err());
        for hex in ["", "0", "GG", "FF", "00\n"] {
            assert!(transfer.chunk(&metadata, 0, hex).is_err());
        }
        let chunk = transfer
            .chunk(&metadata, 0, &encode(&data[..CHUNK]))
            .unwrap();
        assert_eq!(transfer.received(), 0);
        transfer.acknowledged(&chunk);
        assert!(!transfer.complete(&metadata));
        let last = transfer.chunk(&metadata, CHUNK as u64, "07").unwrap();
        transfer.acknowledged(&last);
        assert!(transfer.complete(&metadata));
        assert!(transfer.chunk(&metadata, (CHUNK + 1) as u64, "07").is_err());
        let mut wrong = metadata.clone();
        wrong.sha256 = "0".repeat(64);
        assert!(!transfer.complete(&wrong));
        assert!(Transfer::default().complete(&super::tests::metadata(b"")));
    }
    #[test]
    fn callbacks_require_the_owned_object_and_actual_boolean_confirmation() {
        assert_eq!(
            controller(br#"{"result":{"type":"object","objectId":"owned"}}"#).unwrap(),
            "owned"
        );
        assert!(controller(br#"{"result":{"type":"object"}}"#).is_err());
        assert!(controller(
            br#"{"exceptionDetails":{},"result":{"type":"object","objectId":"owned"}}"#
        )
        .is_err());
        assert!(confirmed(br#"{"result":{"type":"boolean","value":true}}"#).is_ok());
        assert!(confirmed(br#"{"result":{"type":"boolean","value":false}}"#).is_err());
        assert!(callback(&vec![b' '; MAX_CALLBACK + 1]).is_err());
        assert!(acknowledged(b"{}").is_ok());
        for raw in [b"false".as_slice(), b"[]", b"{\"extra\":true}"] {
            assert!(acknowledged(raw).is_err());
        }
        assert!(callback(format!("{}0{}", "[".repeat(17), "]".repeat(17)).as_bytes()).is_err());
    }
}
