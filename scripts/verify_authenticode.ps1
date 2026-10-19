# Native read-only verifier. Do not change execution policy or import certificates.
param([Parameter(Mandatory = $true)][string]$Target)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$signature = Get-AuthenticodeSignature -LiteralPath $Target
if ($null -eq $signature -or $null -eq $signature.SignerCertificate) {
    throw 'No Authenticode signer'
}
@{
    status = [string]$signature.Status
    type = [string]$signature.SignatureType
    thumbprint = [string]$signature.SignerCertificate.Thumbprint
    timestamped = ($null -ne $signature.TimeStamperCertificate)
} | ConvertTo-Json -Compress
