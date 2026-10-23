<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Clients registered through dynamic client registration, one-time
 * authorization codes, and access/refresh token pairs. Secrets, codes and
 * tokens are stored only as SHA-256 hashes.
 */
class CreateMcpOauthTables extends Migration
{
    public function up()
    {
        Schema::create('mcp_oauth_clients', function (Blueprint $table) {
            $table->increments('id');
            $table->string('client_id', 64)->unique();
            $table->string('client_secret_hash', 64)->nullable();
            $table->string('name', 255);
            $table->text('redirect_uris'); // JSON array
            $table->timestamps();
        });

        Schema::create('mcp_oauth_codes', function (Blueprint $table) {
            $table->increments('id');
            $table->string('code_hash', 64)->unique();
            $table->string('client_id', 64);
            $table->integer('user_id')->unsigned();
            $table->text('redirect_uri');
            $table->string('code_challenge', 128);
            $table->string('scope', 255);
            $table->string('resource', 255)->nullable();
            $table->timestamp('expires_at')->nullable();
            $table->boolean('used')->default(false);
            $table->timestamps();
        });

        Schema::create('mcp_oauth_tokens', function (Blueprint $table) {
            $table->increments('id');
            $table->string('access_token_hash', 64)->unique();
            $table->string('refresh_token_hash', 64)->unique();
            $table->string('client_id', 64);
            $table->integer('user_id')->unsigned();
            $table->string('scope', 255);
            $table->string('resource', 255)->nullable();
            $table->timestamp('access_expires_at')->nullable();
            $table->timestamp('refresh_expires_at')->nullable();
            $table->timestamp('revoked_at')->nullable();
            $table->timestamp('last_used_at')->nullable();
            $table->timestamps();
            $table->index(['user_id', 'revoked_at']);
        });
    }

    public function down()
    {
        Schema::dropIfExists('mcp_oauth_tokens');
        Schema::dropIfExists('mcp_oauth_codes');
        Schema::dropIfExists('mcp_oauth_clients');
    }
}
