<?php
/**
 * Relays https://<freescout>/mcp to the hosted mcp-freescout server on localhost.
 *
 * For hosts where Apache's mod_proxy_http is not available. Install as
 * public/mcp-gateway/index.php and add to public/.htaccess, after the
 * "Handle Authorization Header" rule:
 *
 *     RewriteRule ^mcp/?$ mcp-gateway/index.php [L]
 *
 * The Node server does all authentication; this script only passes the
 * request, including its Authorization header, through.
 */

const UPSTREAM = 'http://127.0.0.1:8787/mcp';
const MAX_BODY_BYTES = 5 * 1024 * 1024;

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if ($path !== '/mcp' && $path !== '/mcp/') {
    http_response_code(404);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$body = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if ($body !== false && strlen($body) > MAX_BODY_BYTES) {
    http_response_code(413);
    exit;
}

$authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
if ($authorization === '' && function_exists('getallheaders')) {
    foreach (getallheaders() as $name => $value) {
        if (strcasecmp($name, 'Authorization') === 0) {
            $authorization = $value;
        }
    }
}

// Pass through only the headers MCP needs.
$forward = [];
if ($authorization !== '') {
    $forward[] = 'Authorization: '.$authorization;
}
foreach (['CONTENT_TYPE' => 'Content-Type', 'HTTP_ACCEPT' => 'Accept',
          'HTTP_MCP_PROTOCOL_VERSION' => 'MCP-Protocol-Version',
          'HTTP_MCP_SESSION_ID' => 'Mcp-Session-Id', 'HTTP_LAST_EVENT_ID' => 'Last-Event-ID'] as $key => $name) {
    if (isset($_SERVER[$key]) && $_SERVER[$key] !== '') {
        $forward[] = $name.': '.$_SERVER[$key];
    }
}

// Stream the response back as it arrives so server-sent events are not held up.
while (ob_get_level() > 0) {
    ob_end_flush();
}
header('X-Accel-Buffering: no');

$ch = curl_init(UPSTREAM);
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_HTTPHEADER     => $forward,
    CURLOPT_POSTFIELDS     => in_array($method, ['GET', 'HEAD'], true) ? null : (string) $body,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT        => 300,
    CURLOPT_HEADERFUNCTION => function ($ch, $line) {
        $trimmed = trim($line);
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $trimmed, $m)) {
            http_response_code((int) $m[1]);
        } elseif ($trimmed !== '' && strpos($trimmed, ':') !== false) {
            $name = strtolower(trim(strstr($trimmed, ':', true)));
            if (!in_array($name, ['transfer-encoding', 'connection', 'keep-alive', 'content-length', 'date'], true)) {
                header($trimmed, false);
            }
        }
        return strlen($line);
    },
    CURLOPT_WRITEFUNCTION  => function ($ch, $chunk) {
        echo $chunk;
        flush();
        return strlen($chunk);
    },
]);

if (curl_exec($ch) === false) {
    if (!headers_sent()) {
        http_response_code(502);
        header('Content-Type: text/plain; charset=utf-8');
    }
    echo 'MCP server unavailable';
}
curl_close($ch);
