@extends('layouts.app')

@section('title', __('Connect :app', ['app' => $client->name]))

@section('content')
    <div class="section-heading">
        {{ __('Connect an AI app') }}
    </div>

    <div class="container form-container">
        <div class="row">
            <div class="col-xs-12 col-md-8">
                <h3><strong>{{ $client->name }}</strong> {{ __('wants to access FreeScout as you') }}</h3>
                <p class="text-help">
                    {{ __('Signed in as :name. The app will see and act on the same mailboxes you can, and its actions will show under your name.', ['name' => $user->getFullName()]) }}
                </p>

                <form method="POST" action="{{ route('mcpoauth.approve') }}">
                    {{ csrf_field() }}
                    <input type="hidden" name="client_id" value="{{ $client->client_id }}">
                    <input type="hidden" name="redirect_uri" value="{{ $params['redirect_uri'] }}">
                    <input type="hidden" name="response_type" value="code">
                    <input type="hidden" name="code_challenge" value="{{ $params['code_challenge'] }}">
                    <input type="hidden" name="code_challenge_method" value="S256">
                    <input type="hidden" name="scope" value="{{ $params['scope'] }}">
                    @if ($params['state'] !== null)
                        <input type="hidden" name="state" value="{{ $params['state'] }}">
                    @endif
                    @if ($params['resource'] !== null)
                        <input type="hidden" name="resource" value="{{ $params['resource'] }}">
                    @endif

                    <div class="checkbox">
                        <label>
                            <input type="checkbox" checked disabled>
                            <strong>{{ __('Read tickets') }}</strong> &ndash; {{ __('tickets, customers, attachments and drafts in your mailboxes') }}
                        </label>
                    </div>

                    @if (in_array('freescout:write', $requested, true))
                        <div class="checkbox">
                            <label>
                                <input type="checkbox" name="scope_write" value="1" checked>
                                <strong>{{ __('Work on tickets') }}</strong> &ndash; {{ __('add notes, write and delete reply drafts, change status and assignee') }}
                            </label>
                        </div>
                    @endif

                    @if (in_array('freescout:send', $requested, true))
                        <div class="checkbox">
                            <label>
                                <input type="checkbox" name="scope_send" value="1">
                                <strong>{{ __('Send replies to customers') }}</strong> &ndash; {{ __('email a saved draft to the customer immediately. This cannot be undone.') }}
                            </label>
                        </div>
                    @endif

                    <p class="margin-top">
                        <button type="submit" name="decision" value="allow" class="btn btn-primary">{{ __('Allow') }}</button>
                        <button type="submit" name="decision" value="deny" class="btn btn-default">{{ __('Deny') }}</button>
                    </p>

                    <p class="text-help margin-top">
                        {{ __('You can disconnect it at any time under Connected AI apps in your user menu.') }}
                    </p>
                </form>
            </div>
        </div>
    </div>
@endsection
