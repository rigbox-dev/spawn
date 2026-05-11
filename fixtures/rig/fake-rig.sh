#!/usr/bin/env bash
# fake-rig — minimal scriptable stand-in for the real `rig` binary
# used in unit tests. Reads a "scenario" from the FAKE_RIG_SCENARIO
# env var; each scenario produces a fixed sequence of stdout lines and
# an exit code.

set -e

case "${FAKE_RIG_SCENARIO:-}" in
  "version-0.4.0")
    echo "rigbox 0.4.0"
    exit 0
    ;;
  "version-0.3.0")
    echo "rigbox 0.3.0"
    exit 0
    ;;
  "login-success")
    echo '{"event":"session_created","code":"abc"}'
    echo '{"event":"browser_url","url":"https://rigbox.dev/login?cli_session=abc"}'
    echo '{"event":"polling","elapsed_ms":2000}'
    echo '{"event":"approved","user_email":"j@example.com"}'
    echo '{"event":"saved","path":"/u/.config/rigbox/config.json"}'
    exit 0
    ;;
  "login-timeout")
    echo '{"event":"session_created","code":"abc"}'
    echo '{"event":"browser_url","url":"https://x"}'
    echo '{"event":"error","code":"timeout","message":"Login timed out after 5 minutes"}'
    exit 1
    ;;
  "whoami-authed")
    echo '{"authed":true,"user_email":"j@example.com","user_id":"u_1","source":"xdg_config"}'
    exit 0
    ;;
  "whoami-unauthed")
    echo '{"authed":false,"source":"none"}'
    exit 0
    ;;
  "auth-expired")
    echo '{"event":"error","code":"auth_expired","message":"token rejected"}'
    exit 2
    ;;
  "spawn-with-catalog")
    echo '{"event":"creating","name":"my-ws"}'
    echo '{"event":"created","id":"ws-abc","status":"provisioned"}'
    echo '{"event":"starting"}'
    echo '{"event":"vm_status","status":"booting"}'
    echo '{"event":"vm_status","status":"running"}'
    echo '{"event":"apps_installing","expected":1}'
    echo '{"event":"app_status","app":"claude","status":"installing"}'
    echo '{"event":"app_status","app":"claude","status":"active"}'
    echo '{"event":"ready","id":"ws-abc","name":"my-ws","ssh_user":"my-ws-abc","ssh_host":"eu-west-1.rigbox.dev"}'
    exit 0
    ;;
  "spawn-vm-failed")
    echo '{"event":"creating","name":"my-ws"}'
    echo '{"event":"vm_status","status":"failed"}'
    echo '{"event":"error","code":"vm_failed","message":"Workspace failed to boot (status: failed)"}'
    exit 1
    ;;
  *)
    echo "unknown scenario: ${FAKE_RIG_SCENARIO:-<unset>}" >&2
    exit 64
    ;;
esac
