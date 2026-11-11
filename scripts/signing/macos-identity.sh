#!/usr/bin/env bash
# Provision a macOS code-signing identity in a temporary keychain (#249).
#
#   macos-identity.sh generate WORK_DIR   write a throwaway self-signed certificate and PKCS#12
#   macos-identity.sh provision WORK_DIR  import the release identity, or a throwaway one
#   macos-identity.sh cleanup WORK_DIR    delete the keychain and every file in WORK_DIR
#
# provision uses APPLE_DEVELOPER_ID_P12_BASE64 and APPLE_DEVELOPER_ID_P12_PASSWORD when the
# first is set (kind "release"); otherwise it generates a throwaway identity (kind
# "throwaway") that is valid for codesign but trusted by nothing, so Gatekeeper rejects what
# it signs and Apple will not notarize it. It prints and, under GitHub Actions, exports
# SIGNING_IDENTITY (the SHA-1 hash), SIGNING_KEYCHAIN and SIGNING_KIND. No secret is printed.
set -euo pipefail

mode=${1:?usage: macos-identity.sh generate|provision|cleanup WORK_DIR}
work=${2:?usage: macos-identity.sh generate|provision|cleanup WORK_DIR}
subject='Bun Native CI Throwaway Code Signing'
keychain="$work/signing.keychain-db"

mask() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::add-mask::$1"; fi
}

generate() {
  mkdir -p "$work"
  chmod 700 "$work"
  local password
  password=$(openssl rand -hex 24)
  mask "$password"
  # A configuration file instead of -addext keeps LibreSSL (/usr/bin/openssl) and OpenSSL 3 alike.
  cat >"$work/throwaway.cnf" <<EOF
[req]
distinguished_name = subject
prompt = no
x509_extensions = codesign
[subject]
CN = $subject
[codesign]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF
  openssl req -x509 -newkey rsa:3072 -sha256 -days 2 -nodes -config "$work/throwaway.cnf" \
    -keyout "$work/throwaway.key" -out "$work/throwaway.pem" 2>/dev/null
  # 3DES and a SHA-1 MAC: the PKCS#12 algorithms that macOS `security import` reads.
  openssl pkcs12 -export -inkey "$work/throwaway.key" -in "$work/throwaway.pem" \
    -name "$subject" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -passout "pass:$password" -out "$work/identity.p12"
  rm -f "$work/throwaway.key"
  printf '%s' "$password" >"$work/identity.password"
  chmod 600 "$work/identity.p12" "$work/identity.password"
}

export_value() {
  echo "$1=$2"
  if [ -n "${GITHUB_ENV:-}" ]; then echo "$1=$2" >>"$GITHUB_ENV"; fi
}

case "$mode" in
generate)
  generate
  ;;
provision)
  if [ -n "${APPLE_DEVELOPER_ID_P12_BASE64:-}" ]; then
    if [ -z "${APPLE_DEVELOPER_ID_P12_PASSWORD:-}" ]; then
      echo "APPLE_DEVELOPER_ID_P12_PASSWORD is required with APPLE_DEVELOPER_ID_P12_BASE64" >&2
      exit 1
    fi
    mkdir -p "$work"
    chmod 700 "$work"
    printf '%s' "$APPLE_DEVELOPER_ID_P12_BASE64" | base64 --decode >"$work/identity.p12"
    printf '%s' "$APPLE_DEVELOPER_ID_P12_PASSWORD" >"$work/identity.password"
    chmod 600 "$work/identity.p12" "$work/identity.password"
    kind=release
  else
    generate
    kind=throwaway
  fi
  keychain_password=$(openssl rand -hex 24)
  mask "$keychain_password"
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 7200 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$work/identity.p12" -k "$keychain" -f pkcs12 \
    -P "$(cat "$work/identity.password")" -T /usr/bin/codesign
  rm -f "$work/identity.p12" "$work/identity.password"
  # Let codesign use the key without a UI prompt.
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain" >/dev/null
  # Search the new keychain first and keep the existing ones (login, System) for chains.
  existing=()
  while IFS= read -r line; do
    line=${line#"${line%%[![:space:]]*}"}
    line=${line#\"}
    existing+=("${line%\"}")
  done < <(security list-keychains -d user)
  security list-keychains -d user -s "$keychain" ${existing[@]+"${existing[@]}"}
  # Without -v: a throwaway certificate is untrusted, which codesign accepts but -v hides.
  listing=$(security find-identity -p codesigning "$keychain")
  # The first listed identity: '  1) <40 hex digits> "<name>"'.
  first=$(printf '%s\n' "$listing" | awk '/^ *[0-9]+\) [0-9A-F]+ "/ && length($2) == 40 { print; exit }')
  identity=$(printf '%s\n' "$first" | awk '{ print $2 }')
  name=$(printf '%s\n' "$first" | awk -F'"' '{ print $2 }')
  if [ -z "$identity" ]; then
    echo "No code-signing identity was imported:" >&2
    printf '%s\n' "$listing" >&2
    exit 1
  fi
  if [ "$kind" = release ] && [[ "$name" != "Developer ID Application:"* ]]; then
    echo "::warning::The release identity '$name' is not a Developer ID Application certificate; Apple will not notarize it."
  fi
  echo "Provisioned $kind identity '$name'"
  export_value SIGNING_IDENTITY "$identity"
  export_value SIGNING_KEYCHAIN "$keychain"
  export_value SIGNING_KIND "$kind"
  ;;
cleanup)
  if [ -f "$keychain" ]; then security delete-keychain "$keychain" || true; fi
  rm -rf "$work"
  ;;
*)
  echo "Unknown mode: $mode" >&2
  exit 2
  ;;
esac
