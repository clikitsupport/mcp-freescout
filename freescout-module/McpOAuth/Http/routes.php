<?php

$prefix = \Helper::getSubdirectory();
$namespace = 'Modules\McpOAuth\Http\Controllers';

// Discovery documents and the machine-to-machine endpoints: no session, no CSRF.
Route::group(['middleware' => ['bindings'], 'prefix' => $prefix, 'namespace' => $namespace], function () {
    Route::get('/.well-known/oauth-authorization-server', 'OAuthController@authorizationServerMetadata');
    Route::get('/.well-known/openid-configuration', 'OAuthController@authorizationServerMetadata');
    Route::get('/.well-known/oauth-protected-resource', 'OAuthController@protectedResourceMetadata');
    Route::get('/.well-known/oauth-protected-resource/mcp', 'OAuthController@protectedResourceMetadata');

    Route::post('/oauth/register', 'OAuthController@register');
    Route::post('/oauth/token', 'OAuthController@token');
    Route::post('/oauth/revoke', 'OAuthController@revoke');
    Route::post('/oauth/introspect', 'OAuthController@introspect');
});

// Browser pages: FreeScout session login and CSRF protection.
Route::group(['middleware' => ['web', 'auth'], 'prefix' => $prefix, 'namespace' => $namespace], function () {
    Route::get('/oauth/authorize', 'OAuthController@showAuthorize')->name('mcpoauth.authorize');
    Route::post('/oauth/authorize', 'OAuthController@approve')->name('mcpoauth.approve');
    Route::get('/oauth/connections', 'OAuthController@connections')->name('mcpoauth.connections');
    Route::post('/oauth/connections/{id}/revoke', 'OAuthController@revokeConnection')->name('mcpoauth.connections.revoke');
});
