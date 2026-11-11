# Provision a Windows code-signing certificate in the current user's store (#249).
#
#   windows-identity.ps1 -Mode provision -Work DIR
#   windows-identity.ps1 -Mode cleanup -Work DIR
#
# provision imports WINDOWS_CODESIGN_PFX_BASE64 with WINDOWS_CODESIGN_PFX_PASSWORD when the
# first is set (kind "release"). Otherwise it creates a throwaway self-signed code-signing
# certificate (kind "throwaway") with a non-exportable key, and trusts that one certificate
# in this machine's Root and TrustedPublisher stores so Authenticode verification can build
# its chain. Run the throwaway mode only on a disposable machine such as a hosted runner;
# cleanup removes the certificate from every store it was added to. It prints and, under
# GitHub Actions, exports SIGNING_IDENTITY (the thumbprint) and SIGNING_KIND.
param(
  [Parameter(Mandatory)] [ValidateSet('provision', 'cleanup')] [string]$Mode,
  [Parameter(Mandatory)] [string]$Work
)
$ErrorActionPreference = 'Stop'
$record = Join-Path $Work 'identity.json'
$codeSigning = '1.3.6.1.5.5.7.3.3'

function Export-Value([string]$Name, [string]$Value) {
  Write-Output "$Name=$Value"
  if ($env:GITHUB_ENV) { "$Name=$Value" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8 }
}

if ($Mode -eq 'provision') {
  New-Item -ItemType Directory -Force $Work | Out-Null
  if ($env:WINDOWS_CODESIGN_PFX_BASE64) {
    if (-not $env:WINDOWS_CODESIGN_PFX_PASSWORD) {
      throw 'WINDOWS_CODESIGN_PFX_PASSWORD is required with WINDOWS_CODESIGN_PFX_BASE64'
    }
    $pfx = Join-Path $Work 'identity.pfx'
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:WINDOWS_CODESIGN_PFX_BASE64))
    try {
      $password = ConvertTo-SecureString -String $env:WINDOWS_CODESIGN_PFX_PASSWORD -AsPlainText -Force
      $certificate = Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\My -Password $password |
        Where-Object { $_.HasPrivateKey } | Select-Object -First 1
    } finally {
      Remove-Item -Force -LiteralPath $pfx
    }
    $kind = 'release'
  } else {
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert `
      -Subject 'CN=Bun Native CI Throwaway Code Signing' `
      -CertStoreLocation Cert:\CurrentUser\My -KeyAlgorithm RSA -KeyLength 3072 `
      -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddDays(2)
    $public = Join-Path $Work 'throwaway.cer'
    Export-Certificate -Cert $certificate -FilePath $public | Out-Null
    foreach ($store in 'Cert:\LocalMachine\Root', 'Cert:\LocalMachine\TrustedPublisher') {
      Import-Certificate -FilePath $public -CertStoreLocation $store | Out-Null
    }
    $kind = 'throwaway'
  }
  if (-not $certificate) { throw 'No certificate with a private key was provisioned' }
  $usages = @($certificate.Extensions |
      Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] } |
      ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
  if ($usages -notcontains $codeSigning) { throw "$($certificate.Subject) is not a code-signing certificate" }
  @{
    kind = $kind
    thumbprint = $certificate.Thumbprint
    subject = $certificate.Subject
    notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
  } | ConvertTo-Json | Out-File -FilePath $record -Encoding utf8
  Write-Output "Provisioned $kind certificate $($certificate.Subject)"
  Export-Value SIGNING_IDENTITY $certificate.Thumbprint
  Export-Value SIGNING_KIND $kind
} else {
  if (Test-Path -LiteralPath $record) {
    $identity = Get-Content -Raw -LiteralPath $record | ConvertFrom-Json
    $stores = @('Cert:\CurrentUser\My')
    if ($identity.kind -eq 'throwaway') { $stores += 'Cert:\LocalMachine\Root', 'Cert:\LocalMachine\TrustedPublisher' }
    foreach ($store in $stores) {
      $path = Join-Path $store $identity.thumbprint
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
    }
  }
  if (Test-Path -LiteralPath $Work) { Remove-Item -Recurse -Force -LiteralPath $Work }
}
