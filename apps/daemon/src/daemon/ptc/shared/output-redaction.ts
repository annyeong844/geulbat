interface PtcOutputRedactionOptions {
  redactUrls?: boolean;
}

export function sanitizePtcOutput(
  value: string,
  options: PtcOutputRedactionOptions = {},
): string {
  return sanitizePtcPrivateMarkers(value, options);
}

export function sanitizePtcPrivateMarkers(
  value: string,
  options: PtcOutputRedactionOptions = {},
): string {
  const redacted = value
    .replaceAll(
      /\/geulbat\/package-cache\/?[^"' \n\r\t]*/gu,
      '[redacted:package-cache-path]',
    )
    .replaceAll(
      /\/tmp\/geulbat-package-installs\/?[^"' \n\r\t]*/gu,
      '[redacted:install-workdir]',
    )
    .replaceAll(
      /\/geulbat\/artifacts\/?[^"' \n\r\t]*/gu,
      '[redacted:artifact-path]',
    )
    .replaceAll(
      /\/geulbat\/callbacks\/?[^"' \n\r\t]*/gu,
      '[redacted:callback-path]',
    )
    .replaceAll(/\/var\/run\/docker\.sock/gu, '[redacted:docker-socket]')
    .replaceAll(
      /[^"' \n\r\t]*ptc-package-caches[^"' \n\r\t]*/gu,
      '[redacted:package-cache-path]',
    )
    .replaceAll(
      /[^"' \n\r\t]*callback\.sock[^"' \n\r\t]*/gu,
      '[redacted:callback-socket]',
    )
    .replaceAll(
      /(?:[A-Za-z]:\\|\/)[^"' \n\r\t]*\.geulbat[^"' \n\r\t]*/gu,
      '[redacted:path]',
    )
    .replaceAll(
      /(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/|\/mnt\/c\/Users\/|\/tmp\/|\/var\/folders\/)[^"' \n\r\t]*/gu,
      '[redacted:path]',
    )
    .replaceAll(SECRET_ASSIGNMENT_PATTERN, '[redacted:secret]');

  return options.redactUrls
    ? redacted.replaceAll(/https?:\/\/[^"' \n\r\t)]+/giu, '[redacted:url]')
    : redacted;
}

const SECRET_ASSIGNMENT_PATTERN =
  /"?(?:NPM_TOKEN|NODE_AUTH_TOKEN|provider(?:[_-]?(?:secret|token|material))?|oauth(?:[_-]?(?:secret|token|material))?|session(?:[_-]?(?:secret|token|material))?|access[_-]?token|refresh[_-]?token|id[_-]?token|token(?:[_-]?(?:secret|token|material))?|secret|api[_-]?key|authorization|registry|npmrc|\.npmrc)"?\s*(?:=|:)\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:bearer\s+)?[^"'\s)]+)/giu;
