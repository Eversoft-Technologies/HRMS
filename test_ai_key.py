"""Test Anthropic API keys without printing them.

Usage (from the HRMS folder):
  venv\\Scripts\\python test_ai_key.py            # tests ANTHROPIC_API_KEY from .env
  venv\\Scripts\\python test_ai_key.py --ask      # type/paste a key (hidden)
  venv\\Scripts\\python test_ai_key.py --model claude-opus-5-5
"""
import argparse
import getpass
import hashlib
import os
import sys

import requests

API_URL = 'https://api.anthropic.com/v1/messages'
API_VERSION = '2023-06-01'


def key_id(key):
    """Short fingerprint, the same ID HRMS shows ("Active key ID")."""
    return hashlib.sha256(key.encode()).hexdigest()[:12]


def env_key():
    """ANTHROPIC_API_KEY from the environment, else from .env next to this file."""
    if os.environ.get('ANTHROPIC_API_KEY'):
        return os.environ['ANTHROPIC_API_KEY'].strip()
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                name, _, value = line.partition('=')
                if name.strip() == 'ANTHROPIC_API_KEY':
                    return value.strip().strip('"\'')
    return ''


def test(key, model):
    try:
        r = requests.post(
            API_URL,
            headers={'x-api-key': key, 'anthropic-version': API_VERSION,
                     'content-type': 'application/json'},
            json={'model': model, 'max_tokens': 1,
                  'messages': [{'role': 'user', 'content': 'hi'}]},
            timeout=20,
        )
    except requests.RequestException as e:
        return False, f'Could not reach the Anthropic API: {e.__class__.__name__}'
    if r.ok:
        return True, 'WORKS - key is valid and has credit.'
    try:
        msg = (r.json().get('error') or {}).get('message') or r.text[:200]
    except ValueError:
        msg = r.text[:200]
    if r.status_code == 401:
        return False, 'INVALID - wrong, revoked or mistyped key.'
    if r.status_code == 400 and 'credit balance' in msg.lower():
        return False, ('NO CREDIT - the key is valid, but its Anthropic organization has no API '
                       'credit. Add credit at console.anthropic.com > Settings > Billing.')
    if r.status_code == 403:
        return False, f'NOT ALLOWED - the key cannot use model {model}: {msg}'
    if r.status_code == 404:
        return False, f'UNKNOWN MODEL - "{model}" is not available to this key: {msg}'
    if r.status_code == 429:
        return False, f'RATE-LIMITED - too many requests right now, try again shortly: {msg}'
    return False, f'ERROR {r.status_code}: {msg}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ask', action='store_true', help='enter the key instead of reading .env')
    ap.add_argument('--model', default=os.environ.get('ANTHROPIC_VALIDATION_MODEL') or 'claude-haiku-5-5')
    a = ap.parse_args()

    key = getpass.getpass('Anthropic API key (hidden): ').strip() if a.ask else env_key()
    if not key:
        sys.exit('No key found. Put ANTHROPIC_API_KEY in .env, or run with --ask.')

    kind = 'standard API key' if key.startswith('sk-ant-api03-') else 'NOT a standard sk-ant-api03- key'
    print(f'Key ID : {key_id(key)}  ({kind})')
    print(f'Model  : {a.model}')
    ok, message = test(key, a.model)
    print(f'Result : {message}')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
