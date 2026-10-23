<?php

/**
 * Draft endpoints, authenticated with the same API key as the API & Webhooks module.
 */
if (class_exists(\Modules\ApiWebhooks\Http\Middleware\ApiAuth::class)) {
    Route::group([
        'middleware' => ['bindings', \Modules\ApiWebhooks\Http\Middleware\ApiAuth::class],
        'prefix'     => \Helper::getSubdirectory(true).'api/',
        'namespace'  => 'Modules\McpDrafts\Http\Controllers',
    ], function () {
        Route::post('/conversations/{conversationId}/drafts/{threadId}/send', 'DraftsController@send');
        Route::delete('/conversations/{conversationId}/drafts/{threadId}', 'DraftsController@destroy');
    });
}
