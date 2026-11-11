#!/usr/bin/env bash
# Prepare a disposable hosted macOS runner for VoiceOver automation (#241).
#
# This follows the steps @guidepup/setup 0.29.3 (MIT) performs for CI, without
# its dependency: allow AppleScript control of VoiceOver, skip its welcome
# splash, and grant the runner's process chain Accessibility, event posting and
# Apple Events to VoiceOver and System Events in the user and system TCC
# databases. Hosted macOS runners have System Integrity Protection disabled,
# which is what makes the TCC and /private/var/db writes possible; on a machine
# with SIP enabled this script reports that and exits non-zero.
#
# Never run this on a personal Mac: it rewrites privacy permissions.
set -euo pipefail

if [[ ${CI:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted ]]; then
  echo 'Refusing to change TCC outside a GitHub-hosted runner' >&2
  exit 1
fi
evidence=${1:?usage: macos-voiceover-setup.sh EVIDENCE_DIR}
mkdir -p "$evidence"
{
  sw_vers
  csrutil status || true
} > "$evidence/voiceover-setup-environment.txt" 2>&1
if csrutil status | grep -q enabled; then
  echo 'System Integrity Protection is enabled; VoiceOver AppleScript control cannot be enabled unattended' >&2
  exit 2
fi

defaults write com.apple.VoiceOver4/default SCREnableAppleScript -bool true
defaults write com.apple.VoiceOverTraining doNotShowSplashScreen -bool true
defaults write com.apple.HIToolbox AppleDictationAutoEnable -bool false
# VoiceOver reads this marker before it honours SCREnableAppleScript.
sudo bash -c 'printf a > /private/var/db/Accessibility/.VoiceOverAppleScriptEnabled'

# VoiceOver creates its local preferences on first start; as @guidepup/setup
# does, start it once so they exist, stop it, and write the defaults again.
local_plist="$HOME/Library/Group Containers/group.com.apple.VoiceOver/Library/Preferences/com.apple.VoiceOver4.local.plist"
if [[ ! -f $local_plist ]]; then
  /System/Library/CoreServices/VoiceOver.app/Contents/MacOS/VoiceOverStarter &
  for _ in $(seq 1 100); do
    [[ -f $local_plist ]] && break
    sleep 0.2
  done
  pkill -15 -f 'VoiceOver.app/Contents/MacOS/VoiceOver launchd -s' || true
  for _ in $(seq 1 50); do
    pgrep -x VoiceOver > /dev/null || break
    sleep 0.2
  done
  echo "VoiceOver local preferences present: $([[ -f $local_plist ]] && echo yes || echo no)" \
    >> "$evidence/voiceover-setup-environment.txt"
fi
defaults write com.apple.VoiceOver4/default SCREnableAppleScript -bool true

epoch=$(date +%s)
clients=(
  /usr/sbin/sshd /bin/bash /bin/zsh /usr/bin/osascript com.apple.Terminal
  /usr/local/opt/runner/runprovisioner.sh /usr/local/opt/runner/provisioner/provisioner
  /opt/hca/start_hca.sh /opt/hca/hosted-compute-agent
)
rows=()
for client in "${clients[@]}"; do
  type=1
  [[ $client == com.apple.* ]] && type=0
  for service in kTCCServicePostEvent kTCCServiceAccessibility; do
    rows+=("('$service','$client',$type,2,3,1,NULL,NULL,NULL,'UNUSED',NULL,0,$epoch,NULL,NULL,'UNUSED',$epoch)")
  done
  for target in com.apple.VoiceOver com.apple.systemevents; do
    rows+=("('kTCCServiceAppleEvents','$client',$type,2,3,1,NULL,NULL,0,'$target',NULL,NULL,$epoch,NULL,NULL,'UNUSED',$epoch)")
  done
done
columns='service,client,client_type,auth_value,auth_reason,auth_version,csreq,policy_id,indirect_object_identifier_type,indirect_object_identifier,indirect_object_code_identity,flags,last_modified,pid,pid_version,boot_uuid,last_reminded'
updated='auth_value=excluded.auth_value,auth_reason=excluded.auth_reason,auth_version=excluded.auth_version,flags=excluded.flags,last_modified=excluded.last_modified'
values=$(IFS=,; echo "${rows[*]}")
query="BEGIN IMMEDIATE; INSERT INTO access ($columns) VALUES $values ON CONFLICT DO UPDATE SET $updated; COMMIT;"
# The user database must take the grants; the system one is best effort, as
# in @guidepup/setup.
sudo sqlite3 -bail "$HOME/Library/Application Support/com.apple.TCC/TCC.db" "$query"
echo 'updated the user TCC database' >> "$evidence/voiceover-setup-environment.txt"
if sudo sqlite3 -bail '/Library/Application Support/com.apple.TCC/TCC.db' "$query"; then
  echo 'updated the system TCC database' >> "$evidence/voiceover-setup-environment.txt"
else
  echo '::warning::The system TCC database was not updated'
fi
# Give tccd time to observe the database change.
sleep 1
