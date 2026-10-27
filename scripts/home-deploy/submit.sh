#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ "$GITHUB_REF" == refs/heads/master ]]
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$JUMP_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+$ ]]
[[ "$HOME_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+$ ]]
[[ "$HOME_PORT" =~ ^[0-9]{1,5}$ ]] && (( HOME_PORT > 0 && HOME_PORT < 65536 ))
[[ -n "$HOME_KEY" && -n "$JUMP_KEY" && -n "$KNOWN_HOSTS" ]]
mkdir -p tmp/home-ssh
cleanup() {
  ssh -F tmp/home-ssh/config -O exit scanaki-home-target 2>/dev/null || true
  ssh -F tmp/home-ssh/config -O exit scanaki-home-jump 2>/dev/null || true
  rm -f tmp/home-ssh/home.key tmp/home-ssh/jump.key
}
trap cleanup EXIT
printf '%s\n' "$HOME_KEY" > tmp/home-ssh/home.key
printf '%s\n' "$JUMP_KEY" > tmp/home-ssh/jump.key
printf '%s\n' "$KNOWN_HOSTS" > tmp/home-ssh/known_hosts
ssh-keygen -y -f tmp/home-ssh/home.key >/dev/null
ssh-keygen -y -f tmp/home-ssh/jump.key >/dev/null
# Host keys are provisioned out-of-band; never trust a runtime ssh-keyscan result.
cat > tmp/home-ssh/config <<EOF
Host scanaki-home-jump
  HostName $JUMP_HOST
  User scanaki-ci-jump
  IdentityFile $PWD/tmp/home-ssh/jump.key
Host scanaki-home-target
  HostName $HOME_HOST
  Port $HOME_PORT
  User scanaki-ci
  IdentityFile $PWD/tmp/home-ssh/home.key
  ProxyJump scanaki-home-jump
Host *
  ControlMaster auto
  ControlPersist 120
  ControlPath $PWD/tmp/home-ssh/%C
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
  UserKnownHostsFile $PWD/tmp/home-ssh/known_hosts
  ConnectTimeout 20
  ServerAliveInterval 30
  ServerAliveCountMax 3
  ForwardAgent no
EOF
docker save -o tmp/home-images.tar \
  "scanaki-home-release-back:$GITHUB_SHA" \
  "scanaki-home-release-front:$GITHUB_SHA" \
  "scanaki-home-release-ws-bridge:$GITHUB_SHA"
digest="$(sha256sum tmp/home-images.tar | cut -d ' ' -f1)"
latest="$(gh api "repos/$GITHUB_REPOSITORY/commits/master" --jq .sha)"
[[ "$latest" == "$GITHUB_SHA" ]] || { echo 'Superseded before submission'; exit 1; }
ssh -F tmp/home-ssh/config scanaki-home-target "submit $GITHUB_SHA $digest" < tmp/home-images.tar
# This only observes the durable unit. Cancellation/timeout does NOT stop HOME.
for attempt in $(seq 1 30); do
  status="$(ssh -F tmp/home-ssh/config scanaki-home-target "status $GITHUB_SHA")"
  case "$status" in
    succeeded) echo "HOME deployed $GITHUB_SHA"; exit 0 ;;
    failed|blocked|unknown|superseded) echo "HOME deployment $status; operator inspection required"; exit 1 ;;
    queued|preparing|mutating) ;;
    *) echo 'Invalid receiver status'; exit 1 ;;
  esac
  sleep 30
done
echo 'HOME status observation timed out; inspect durable unit before retrying.'
exit 1
