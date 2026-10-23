@extends('layouts.app')

@section('title', __('Cannot connect app'))

@section('content')
    <div class="section-heading">
        {{ __('Cannot connect app') }}
    </div>

    <div class="container form-container">
        <div class="row">
            <div class="col-xs-12">
                <p>{{ $message }}</p>
            </div>
        </div>
    </div>
@endsection
