<?php

namespace Modules\McpOAuth\Http\Controllers;

use App\User;
use Illuminate\Http\Request;
use Illuminate\Routing\Controller;
use Illuminate\Support\Facades\DB;

/**
 * A small OAuth 2.1 authorization server for the hosted mcp-freescout server.
 *
 * Supports what MCP clients such as Claude and Grok use: discovery metadata
 * (RFC 8414, RFC 9728), dynamic client registration (RFC 7591), the
 * authorization code grant with mandatory PKCE S256, refresh token rotation,
 * and revocation (RFC 7009). Sign-in and consent use the FreeScout session,
 * so each connection acts as the FreeScout user who approved it.
 *
 * The MCP server checks tokens through the introspect endpoint, which is
 * authenticated with the API & Webhooks API key.
 */
class OAuthController extends Controller
{
    const SCOPE_READ = 'freescout:read';
    const SCOPE_WRITE = 'freescout:write';
    const SCOPE_SEND = 'freescout:send';
    const SCOPES = [self::SCOPE_READ, self::SCOPE_WRITE, self::SCOPE_SEND];

    const CODE_TTL = 600;               // 10 minutes
    const ACCESS_TTL = 3600;            // 1 hour
    const REFRESH_TTL = 30 * 86400;     // 30 days
    const LAST_USED_GRANULARITY = 300;  // update last_used_at at most every 5 minutes

    // ------------------------------------------------------------------
    // Discovery
    // ------------------------------------------------------------------

    public function authorizationServerMetadata()
    {
        $issuer = self::issuer();

        return $this->json([
            'issuer'                                => $issuer,
            'authorization_endpoint'                => $issuer.'/oauth/authorize',
            'token_endpoint'                        => $issuer.'/oauth/token',
            'registration_endpoint'                 => $issuer.'/oauth/register',
            'revocation_endpoint'                   => $issuer.'/oauth/revoke',
            'response_types_supported'              => ['code'],
            'grant_types_supported'                 => ['authorization_code', 'refresh_token'],
            'code_challenge_methods_supported'      => ['S256'],
            'token_endpoint_auth_methods_supported' => ['none', 'client_secret_post', 'client_secret_basic'],
            'revocation_endpoint_auth_methods_supported' => ['none', 'client_secret_post', 'client_secret_basic'],
            'scopes_supported'                      => self::SCOPES,
            'authorization_response_iss_parameter_supported' => true,
        ]);
    }

    public function protectedResourceMetadata()
    {
        $issuer = self::issuer();

        return $this->json([
            'resource'                 => $issuer.'/mcp',
            'authorization_servers'    => [$issuer],
            'scopes_supported'         => self::SCOPES,
            'bearer_methods_supported' => ['header'],
            'resource_name'            => 'FreeScout',
        ]);
    }

    // ------------------------------------------------------------------
    // Dynamic client registration (RFC 7591)
    // ------------------------------------------------------------------

    public function register(Request $request)
    {
        $data = $request->json()->all() ?: $request->all();

        $redirect_uris = $data['redirect_uris'] ?? null;
        if (!is_array($redirect_uris) || !$redirect_uris || count($redirect_uris) > 10) {
            return $this->oauthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array.');
        }
        foreach ($redirect_uris as $uri) {
            if (!is_string($uri) || !self::isAllowedRedirectUri($uri)) {
                return $this->oauthError('invalid_redirect_uri', 'Redirect URIs must use https, or http on localhost.');
            }
        }

        $auth_method = $data['token_endpoint_auth_method'] ?? 'none';
        if (!in_array($auth_method, ['none', 'client_secret_post', 'client_secret_basic'], true)) {
            return $this->oauthError('invalid_client_metadata', 'Unsupported token_endpoint_auth_method.');
        }

        $name = trim((string) ($data['client_name'] ?? ''));
        $name = $name !== '' ? mb_substr($name, 0, 100) : 'Unnamed app';

        $client_id = 'mcp_'.bin2hex(random_bytes(16));
        $client_secret = $auth_method === 'none' ? null : bin2hex(random_bytes(32));
        $now = now();

        DB::table('mcp_oauth_clients')->insert([
            'client_id'          => $client_id,
            'client_secret_hash' => $client_secret ? self::hash($client_secret) : null,
            'name'               => $name,
            'redirect_uris'      => json_encode(array_values($redirect_uris)),
            'created_at'         => $now,
            'updated_at'         => $now,
        ]);

        $response = [
            'client_id'                  => $client_id,
            'client_id_issued_at'        => $now->timestamp,
            'client_name'                => $name,
            'redirect_uris'              => array_values($redirect_uris),
            'grant_types'                => ['authorization_code', 'refresh_token'],
            'response_types'             => ['code'],
            'token_endpoint_auth_method' => $auth_method,
        ];
        if ($client_secret) {
            $response['client_secret'] = $client_secret;
            $response['client_secret_expires_at'] = 0;
        }

        return $this->json($response, 201);
    }

    // ------------------------------------------------------------------
    // Authorization endpoint: sign-in (FreeScout session) and consent
    // ------------------------------------------------------------------

    public function showAuthorize(Request $request)
    {
        $params = $this->validateAuthorizeRequest($request);
        if (!is_array($params)) {
            return $params;
        }

        $user = auth()->user();

        return view('mcpoauth::consent', [
            'client'    => $params['client'],
            'params'    => $params,
            'user'      => $user,
            'requested' => $params['scopes'],
        ]);
    }

    public function approve(Request $request)
    {
        $params = $this->validateAuthorizeRequest($request);
        if (!is_array($params)) {
            return $params;
        }

        if ($request->input('decision') !== 'allow') {
            return $this->redirectWithParams($params['redirect_uri'], [
                'error' => 'access_denied',
                'state' => $params['state'],
                'iss'   => self::issuer(),
            ]);
        }

        // Read is always granted. Write is on by default; send is opt-in.
        $scopes = [self::SCOPE_READ];
        if ($request->input('scope_write') && in_array(self::SCOPE_WRITE, $params['scopes'], true)) {
            $scopes[] = self::SCOPE_WRITE;
        }
        if ($request->input('scope_send') && in_array(self::SCOPE_SEND, $params['scopes'], true)) {
            $scopes[] = self::SCOPE_SEND;
        }

        $code = bin2hex(random_bytes(32));
        $now = now();
        DB::table('mcp_oauth_codes')->insert([
            'code_hash'      => self::hash($code),
            'client_id'      => $params['client']->client_id,
            'user_id'        => auth()->user()->id,
            'redirect_uri'   => $params['redirect_uri'],
            'code_challenge' => $params['code_challenge'],
            'scope'          => implode(' ', $scopes),
            'resource'       => $params['resource'],
            'expires_at'     => $now->copy()->addSeconds(self::CODE_TTL),
            'created_at'     => $now,
            'updated_at'     => $now,
        ]);

        return $this->redirectWithParams($params['redirect_uri'], [
            'code'  => $code,
            'state' => $params['state'],
            'iss'   => self::issuer(),
        ]);
    }

    /**
     * @return array|\Illuminate\Http\Response
     */
    private function validateAuthorizeRequest(Request $request)
    {
        $client = $this->findClient((string) $request->input('client_id'));
        $redirect_uri = (string) $request->input('redirect_uri');

        // Without a known client and registered redirect URI, never redirect.
        if (!$client) {
            return $this->errorPage(__('This app is not registered. Remove the connector and add it again.'));
        }
        $registered = json_decode($client->redirect_uris, true) ?: [];
        if ($redirect_uri === '' && count($registered) === 1) {
            $redirect_uri = $registered[0];
        }
        if (!in_array($redirect_uri, $registered, true)) {
            return $this->errorPage(__('The app sent a redirect address it did not register.'));
        }

        $state = $request->input('state');
        $fail = function ($error, $description) use ($redirect_uri, $state) {
            return $this->redirectWithParams($redirect_uri, [
                'error'             => $error,
                'error_description' => $description,
                'state'             => $state,
                'iss'               => self::issuer(),
            ]);
        };

        if ($request->input('response_type') !== 'code') {
            return $fail('unsupported_response_type', 'Only response_type=code is supported.');
        }
        $challenge = (string) $request->input('code_challenge');
        if ($challenge === '' || $request->input('code_challenge_method') !== 'S256'
            || !preg_match('/^[A-Za-z0-9_-]{43,128}$/', $challenge)) {
            return $fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
        }

        $requested = array_values(array_filter(explode(' ', (string) $request->input('scope'))));
        $scopes = $requested ? array_values(array_intersect($requested, self::SCOPES)) : self::SCOPES;
        if (!$scopes) {
            return $fail('invalid_scope', 'Requested scopes are not supported.');
        }
        if (!in_array(self::SCOPE_READ, $scopes, true)) {
            $scopes[] = self::SCOPE_READ;
        }

        $resource = $request->input('resource');
        $resource = is_string($resource) && $resource !== '' ? mb_substr($resource, 0, 255) : null;

        return [
            'client'         => $client,
            'redirect_uri'   => $redirect_uri,
            'state'          => is_string($state) ? $state : null,
            'code_challenge' => $challenge,
            'scopes'         => $scopes,
            'scope'          => implode(' ', $scopes),
            'resource'       => $resource,
        ];
    }

    // ------------------------------------------------------------------
    // Token endpoint
    // ------------------------------------------------------------------

    public function token(Request $request)
    {
        $client = $this->authenticateClient($request);
        if (!$client) {
            return $this->oauthError('invalid_client', 'Client authentication failed.', 401);
        }

        switch ($request->input('grant_type')) {
            case 'authorization_code':
                return $this->exchangeCode($request, $client);
            case 'refresh_token':
                return $this->refresh($request, $client);
            default:
                return $this->oauthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
        }
    }

    private function exchangeCode(Request $request, $client)
    {
        $code = DB::table('mcp_oauth_codes')
            ->where('code_hash', self::hash((string) $request->input('code')))
            ->first();

        if (!$code || $code->client_id !== $client->client_id) {
            return $this->oauthError('invalid_grant', 'Unknown authorization code.');
        }
        if ($code->used) {
            // A replayed code may mean it leaked: revoke what it produced.
            DB::table('mcp_oauth_tokens')
                ->where('client_id', $code->client_id)
                ->where('user_id', $code->user_id)
                ->where('created_at', '>=', $code->created_at)
                ->whereNull('revoked_at')
                ->update(['revoked_at' => now()]);

            return $this->oauthError('invalid_grant', 'Authorization code was already used.');
        }
        if (strtotime($code->expires_at) < time()) {
            return $this->oauthError('invalid_grant', 'Authorization code expired.');
        }
        if ((string) $request->input('redirect_uri', $code->redirect_uri) !== $code->redirect_uri) {
            return $this->oauthError('invalid_grant', 'redirect_uri does not match.');
        }
        $verifier = (string) $request->input('code_verifier');
        if (!preg_match('/^[A-Za-z0-9._~-]{43,128}$/', $verifier)
            || !hash_equals($code->code_challenge, self::base64url(hash('sha256', $verifier, true)))) {
            return $this->oauthError('invalid_grant', 'PKCE verification failed.');
        }

        DB::table('mcp_oauth_codes')->where('id', $code->id)->update(['used' => true, 'updated_at' => now()]);

        $user = User::find($code->user_id);
        if (!$user || !$user->isActive()) {
            return $this->oauthError('invalid_grant', 'The approving user is no longer active.');
        }

        return $this->issueTokens($client->client_id, $code->user_id, $code->scope, $code->resource);
    }

    private function refresh(Request $request, $client)
    {
        $row = DB::table('mcp_oauth_tokens')
            ->where('refresh_token_hash', self::hash((string) $request->input('refresh_token')))
            ->first();

        if (!$row || $row->client_id !== $client->client_id) {
            return $this->oauthError('invalid_grant', 'Unknown refresh token.');
        }
        if ($row->revoked_at) {
            // Reuse of a rotated refresh token: revoke the whole connection.
            DB::table('mcp_oauth_tokens')
                ->where('client_id', $row->client_id)
                ->where('user_id', $row->user_id)
                ->whereNull('revoked_at')
                ->update(['revoked_at' => now()]);

            return $this->oauthError('invalid_grant', 'Refresh token was revoked.');
        }
        if (strtotime($row->refresh_expires_at) < time()) {
            return $this->oauthError('invalid_grant', 'Refresh token expired.');
        }
        $user = User::find($row->user_id);
        if (!$user || !$user->isActive()) {
            return $this->oauthError('invalid_grant', 'The approving user is no longer active.');
        }

        DB::table('mcp_oauth_tokens')->where('id', $row->id)->update(['revoked_at' => now(), 'updated_at' => now()]);

        return $this->issueTokens($row->client_id, $row->user_id, $row->scope, $row->resource);
    }

    private function issueTokens($client_id, $user_id, $scope, $resource)
    {
        $access = 'fsat_'.bin2hex(random_bytes(32));
        $refresh = 'fsrt_'.bin2hex(random_bytes(32));
        $now = now();

        DB::table('mcp_oauth_tokens')->insert([
            'access_token_hash'  => self::hash($access),
            'refresh_token_hash' => self::hash($refresh),
            'client_id'          => $client_id,
            'user_id'            => $user_id,
            'scope'              => $scope,
            'resource'           => $resource,
            'access_expires_at'  => $now->copy()->addSeconds(self::ACCESS_TTL),
            'refresh_expires_at' => $now->copy()->addSeconds(self::REFRESH_TTL),
            'created_at'         => $now,
            'updated_at'         => $now,
        ]);

        return $this->json([
            'access_token'  => $access,
            'token_type'    => 'Bearer',
            'expires_in'    => self::ACCESS_TTL,
            'refresh_token' => $refresh,
            'scope'         => $scope,
        ]);
    }

    // ------------------------------------------------------------------
    // Revocation (RFC 7009)
    // ------------------------------------------------------------------

    public function revoke(Request $request)
    {
        $client = $this->authenticateClient($request);
        if (!$client) {
            return $this->oauthError('invalid_client', 'Client authentication failed.', 401);
        }

        $hash = self::hash((string) $request->input('token'));
        DB::table('mcp_oauth_tokens')
            ->where('client_id', $client->client_id)
            ->where(function ($query) use ($hash) {
                $query->where('access_token_hash', $hash)->orWhere('refresh_token_hash', $hash);
            })
            ->whereNull('revoked_at')
            ->update(['revoked_at' => now(), 'updated_at' => now()]);

        // RFC 7009: answer 200 whether or not the token existed.
        return $this->json([]);
    }

    // ------------------------------------------------------------------
    // Introspection for the MCP server (API key protected)
    // ------------------------------------------------------------------

    public function introspect(Request $request)
    {
        $key = (string) $request->header('X-FreeScout-API-Key', '');
        if ($key === '' || !class_exists(\ApiWebhooks::class)
            || !hash_equals((string) \ApiWebhooks::getApiKey(), $key)) {
            return $this->json(['error' => 'unauthorized'], 401);
        }

        $inactive = $this->json(['active' => false]);

        $row = DB::table('mcp_oauth_tokens')
            ->where('access_token_hash', self::hash((string) $request->input('token')))
            ->first();
        if (!$row || $row->revoked_at || strtotime($row->access_expires_at) < time()) {
            return $inactive;
        }

        $user = User::find($row->user_id);
        if (!$user || !$user->isActive()) {
            return $inactive;
        }

        if (!$row->last_used_at || strtotime($row->last_used_at) < time() - self::LAST_USED_GRANULARITY) {
            DB::table('mcp_oauth_tokens')->where('id', $row->id)->update(['last_used_at' => now()]);
        }

        return $this->json([
            'active'      => true,
            'scope'       => $row->scope,
            'client_id'   => $row->client_id,
            'exp'         => strtotime($row->access_expires_at),
            'aud'         => $row->resource,
            'user_id'     => (int) $user->id,
            'user_name'   => $user->getFullName(),
            'is_admin'    => (bool) $user->isAdmin(),
            'mailbox_ids' => array_map('intval', $user->mailboxesIdsCanView()),
        ]);
    }

    // ------------------------------------------------------------------
    // Connected apps page
    // ------------------------------------------------------------------

    public function connections(Request $request)
    {
        $user = auth()->user();

        $query = DB::table('mcp_oauth_tokens as t')
            ->leftJoin('mcp_oauth_clients as c', 'c.client_id', '=', 't.client_id')
            ->leftJoin('users as u', 'u.id', '=', 't.user_id')
            ->whereNull('t.revoked_at')
            ->where('t.refresh_expires_at', '>', now())
            ->select('t.id', 't.user_id', 't.scope', 't.created_at', 't.last_used_at',
                'c.name as client_name', 'u.first_name', 'u.last_name')
            ->orderBy('t.created_at', 'desc');

        if (!$user->isAdmin()) {
            $query->where('t.user_id', $user->id);
        }

        return view('mcpoauth::connections', [
            'connections' => $query->get(),
            'is_admin'    => $user->isAdmin(),
        ]);
    }

    public function revokeConnection(Request $request, $id)
    {
        $user = auth()->user();
        $query = DB::table('mcp_oauth_tokens')->where('id', (int) $id)->whereNull('revoked_at');
        if (!$user->isAdmin()) {
            $query->where('user_id', $user->id);
        }
        $query->update(['revoked_at' => now(), 'updated_at' => now()]);

        \Session::flash('flash_success_floating', __('Access revoked'));

        return redirect()->route('mcpoauth.connections');
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    public static function issuer()
    {
        return rtrim(config('app.url'), '/');
    }

    public static function hash($value)
    {
        return hash('sha256', (string) $value);
    }

    public static function base64url($bytes)
    {
        return rtrim(strtr(base64_encode($bytes), '+/', '-_'), '=');
    }

    public static function isAllowedRedirectUri($uri)
    {
        $parts = parse_url($uri);
        if (!$parts || empty($parts['scheme']) || empty($parts['host']) || isset($parts['fragment'])) {
            return false;
        }
        if ($parts['scheme'] === 'https') {
            return true;
        }

        return $parts['scheme'] === 'http' && in_array($parts['host'], ['localhost', '127.0.0.1', '[::1]'], true);
    }

    private function findClient($client_id)
    {
        if ($client_id === '') {
            return null;
        }

        return DB::table('mcp_oauth_clients')->where('client_id', $client_id)->first();
    }

    /**
     * Public clients send only client_id; confidential clients must also
     * present their secret (client_secret_post or client_secret_basic).
     */
    private function authenticateClient(Request $request)
    {
        $client_id = (string) $request->input('client_id');
        $secret = $request->input('client_secret');

        $basic = $request->header('Authorization', '');
        if (stripos($basic, 'Basic ') === 0) {
            $decoded = base64_decode(substr($basic, 6), true);
            if ($decoded !== false && strpos($decoded, ':') !== false) {
                list($basic_id, $basic_secret) = explode(':', $decoded, 2);
                $client_id = urldecode($basic_id);
                $secret = urldecode($basic_secret);
            }
        }

        $client = $this->findClient($client_id);
        if (!$client) {
            return null;
        }
        if ($client->client_secret_hash) {
            if (!is_string($secret) || !hash_equals($client->client_secret_hash, self::hash($secret))) {
                return null;
            }
        }

        return $client;
    }

    private function redirectWithParams($uri, array $params)
    {
        $params = array_filter($params, function ($value) {
            return $value !== null && $value !== '';
        });
        $separator = strpos($uri, '?') === false ? '?' : '&';

        return redirect()->away($uri.$separator.http_build_query($params));
    }

    private function oauthError($error, $description, $status = 400)
    {
        return $this->json(['error' => $error, 'error_description' => $description], $status);
    }

    private function json($data, $status = 200)
    {
        return response()->json($data, $status, [
            'Cache-Control'               => 'no-store',
            'Pragma'                      => 'no-cache',
            'Access-Control-Allow-Origin' => '*',
        ]);
    }

    private function errorPage($message)
    {
        return response()->view('mcpoauth::error', ['message' => $message], 400);
    }
}
