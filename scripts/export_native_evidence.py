"""Explicit sanitized export; never changes outcome, receipts or failure accounting."""

import json
import re
import sys

EXPORT = {"schema": 1, "redactions": ["fixture-nonces"], "correlation": "not-retained"}
NONCE = re.compile(r"(?<![a-fA-F0-9])[a-fA-F0-9]{48}(?![a-fA-F0-9])")


def sanitize_report(value):
    if not isinstance(value, dict):
        raise ValueError("Native report must be an object")
    if "nativeEvidenceExport" in value and value["nativeEvidenceExport"] != EXPORT:
        raise ValueError("Unknown native evidence export schema")

    def visit(item):
        if isinstance(item, list):
            return [visit(child) for child in item]
        if not isinstance(item, dict):
            return item
        result = {key: visit(child) for key, child in item.items()}
        if item.get("schema") == 1 and "exitCode" in item and "samples" in item:
            prior = item.get("observationExport")
            if prior is not None:
                if (
                    prior
                    not in (
                        {"schema": 1, "correlation": "omitted"},
                        {"schema": 1, "correlation": "absent"},
                    )
                    or "observationId" in item
                ):
                    raise ValueError("Invalid previously exported observation")
            else:
                identity = item.get("observationId")
                if "observationId" in item and (
                    not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{48}", identity)
                ):
                    raise ValueError("Invalid source observation identity")
                result.pop("observationId", None)
                result["observationExport"] = {
                    "schema": 1,
                    "correlation": "omitted" if identity is not None else "absent",
                }
        return result

    result = visit(value)
    result["nativeEvidenceExport"] = EXPORT.copy()
    # Preserve the existing log/embedded-string nonce redaction policy. Report
    # hashes (64 hex) and all actual acceptance/cleanup fields remain unchanged.
    return json.loads(NONCE.sub("[fixture-nonce]", json.dumps(result)))


if __name__ == "__main__":
    json.dump(sanitize_report(json.load(sys.stdin)), sys.stdout)
    sys.stdout.write("\n")
