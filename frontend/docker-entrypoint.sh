#!/bin/sh
set -eu

RUNTIME_DIR="${RUNTIME_DIR:-/tmp/runtime}"
API_BASE="${API_BASE:-/api}"
OIDC_TOKEN_ORIGIN="${OIDC_TOKEN_ORIGIN:-}"

fail() {
    echo "docker-entrypoint: $1" >&2
    exit 1
}

# Values are interpolated into JavaScript and nginx directives, so only URL-safe characters are accepted.
check_chars() {
    case "$2" in
        *[!A-Za-z0-9:/._~%-]*) fail "$1 contains characters that are not allowed" ;;
    esac
}

# Plain http only for the exact loopback hosts, so http://localhost.evil.com is rejected.
check_url() {
    check_chars "$1" "$2"
    printf '%s' "$2" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/.*)?$' && return 0
    printf '%s' "$2" | grep -Eq '^http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(/.*)?$' && return 0
    fail "$1 must be an https URL (plain http only for localhost or 127.0.0.1)"
}

origin_of() {
    printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*$#\1#'
}

: "${OIDC_ISSUER:?OIDC_ISSUER is required}"
: "${OIDC_CLIENT_ID:?OIDC_CLIENT_ID is required}"
: "${OIDC_REDIRECT_URI:?OIDC_REDIRECT_URI is required}"
: "${OIDC_LOGOUT_URL:?OIDC_LOGOUT_URL is required}"
: "${OIDC_POST_LOGOUT_URI:?OIDC_POST_LOGOUT_URI is required}"
: "${UPLOAD_ORIGIN:?UPLOAD_ORIGIN is required}"

check_chars API_BASE "$API_BASE"
case "$API_BASE" in
    //*) fail "API_BASE must be a same-origin path such as /api" ;;
    /*) ;;
    *) fail "API_BASE must be a same-origin path such as /api" ;;
esac
check_url OIDC_ISSUER "$OIDC_ISSUER"
check_chars OIDC_CLIENT_ID "$OIDC_CLIENT_ID"
check_url OIDC_REDIRECT_URI "$OIDC_REDIRECT_URI"
check_url OIDC_LOGOUT_URL "$OIDC_LOGOUT_URL"
check_url OIDC_POST_LOGOUT_URI "$OIDC_POST_LOGOUT_URI"
check_url UPLOAD_ORIGIN "$UPLOAD_ORIGIN"
[ -z "$OIDC_TOKEN_ORIGIN" ] || check_url OIDC_TOKEN_ORIGIN "$OIDC_TOKEN_ORIGIN"

CONNECT_SRC="'self' $(origin_of "$UPLOAD_ORIGIN") $(origin_of "$OIDC_ISSUER")"
[ -z "$OIDC_TOKEN_ORIGIN" ] || CONNECT_SRC="$CONNECT_SRC $(origin_of "$OIDC_TOKEN_ORIGIN")"

mkdir -p "$RUNTIME_DIR"

printf 'window.__APP_CONFIG__ = {"apiBase":"%s","oidcIssuer":"%s","oidcClientId":"%s","oidcRedirectUri":"%s","oidcLogoutUrl":"%s","oidcPostLogoutUri":"%s"};\n' \
    "$API_BASE" "$OIDC_ISSUER" "$OIDC_CLIENT_ID" "$OIDC_REDIRECT_URI" "$OIDC_LOGOUT_URL" "$OIDC_POST_LOGOUT_URI" \
    > "$RUNTIME_DIR/config.js"

cat > "$RUNTIME_DIR/security-headers.conf" <<EOF
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src $CONNECT_SRC; frame-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header X-Frame-Options "DENY" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
EOF

exec "$@"
