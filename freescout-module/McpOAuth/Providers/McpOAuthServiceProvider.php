<?php

namespace Modules\McpOAuth\Providers;

use Illuminate\Support\ServiceProvider;

class McpOAuthServiceProvider extends ServiceProvider
{
    public function boot()
    {
        $this->loadMigrationsFrom(__DIR__.'/../Database/Migrations');
        $this->loadViewsFrom(__DIR__.'/../Resources/views', 'mcpoauth');

        // "Connected AI apps" in the user menu, under Your Profile.
        \Eventy::addAction('menu_right.user.after_profile', function () {
            echo '<li><a href="'.e(route('mcpoauth.connections')).'">'.e(__('Connected AI apps')).'</a></li>';
        });
    }

    public function register()
    {
    }
}
