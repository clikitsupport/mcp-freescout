@extends('layouts.app')

@section('title', __('Connected AI apps'))

@section('content')
    <div class="section-heading">
        {{ __('Connected AI apps') }}
    </div>

    @include('partials/flash_messages')

    <div class="container form-container">
        <div class="row">
            <div class="col-xs-12">
                @if (!count($connections))
                    <p>{{ __('No AI apps are connected.') }}</p>
                @else
                    <table class="table table-striped">
                        <thead>
                            <tr>
                                <th>{{ __('App') }}</th>
                                @if ($is_admin)
                                    <th>{{ __('User') }}</th>
                                @endif
                                <th>{{ __('Access') }}</th>
                                <th>{{ __('Connected') }}</th>
                                <th>{{ __('Last used') }}</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            @foreach ($connections as $connection)
                                <tr>
                                    <td>{{ $connection->client_name ?: __('Unknown app') }}</td>
                                    @if ($is_admin)
                                        <td>{{ trim($connection->first_name.' '.$connection->last_name) }}</td>
                                    @endif
                                    <td>
                                        {{ implode(', ', array_map(function ($scope) {
                                            return ['freescout:read' => __('read'), 'freescout:write' => __('work on tickets'), 'freescout:send' => __('send replies')][$scope] ?? $scope;
                                        }, explode(' ', $connection->scope))) }}
                                    </td>
                                    <td>{{ $connection->created_at }}</td>
                                    <td>{{ $connection->last_used_at ?: __('never') }}</td>
                                    <td>
                                        <form method="POST" action="{{ route('mcpoauth.connections.revoke', ['id' => $connection->id]) }}">
                                            {{ csrf_field() }}
                                            <button type="submit" class="btn btn-default btn-xs">{{ __('Disconnect') }}</button>
                                        </form>
                                    </td>
                                </tr>
                            @endforeach
                        </tbody>
                    </table>
                @endif
            </div>
        </div>
    </div>
@endsection
