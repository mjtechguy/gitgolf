#!/usr/bin/env python3
"""Qualify ordinary issue edits/lifecycle against the local supported native API.

Creates and purges disposable users/repository. No source workflows, inference
or retained account changes. Credentials remain in memory. This characterizes
native permissions and body versions; it does not qualify atomic title/state
writes, target-address fences or protected publication.
"""
import secrets
import sys
import uuid
sys.dont_write_bytecode = True
from smoke import admin, client, provider, ready, rpc


def main():
    ready()
    prefix = 'golf-issue-update-' + secrets.token_hex(4)
    users, sessions, actors = [], [], []
    try:
        for role in ['owner', 'writer', 'reader', 'outsider']:
            name = prefix + '-' + role
            admin('create', '--username', name, '--email', name+'@example.invalid',
                  '--random-password', '--must-change-password=false')
            users.append(name)
            token = admin('generate-access-token', '--username', name, '--token-name', prefix,
                          '--scopes', 'write:user,write:repository,write:issue', '--raw')
            session = client(); sessions.append(session)
            rpc(session, 'SessionService/LoginWithForgeToken', {'token': token})
            actors.append((name, token, session))
        name, token, owner = actors[0]
        _, _, writer = actors[1]; _, _, reader = actors[2]; _, _, outsider = actors[3]
        repository = {'owner': name, 'name': 'issue-updates'}
        path = 'repos/'+name+'/issue-updates'
        native = provider(token, 'POST', 'user/repos', {'name':repository['name'], 'private':True, 'auto_init':True}, expected=201)
        for actor, permission in [(actors[1], 'write'), (actors[2], 'read')]:
            provider(token, 'PUT', path+'/collaborators/'+actor[0], {'permission':permission}, expected=204)
        def create(session, title):
            result = rpc(session, 'RepositoryService/CreateIssue', {'repository':repository, 'repositoryId':str(native['id']), 'title':title, 'body':'Original description', 'idempotencyKey':str(uuid.uuid4())})
            assert result['mutation']['state'] == 'ISSUE_MUTATION_STATE_SUCCEEDED'
            return result['issue']
        def read(number, session=owner):
            return rpc(session, 'RepositoryService/GetIssue', {'repository':repository, 'number':number})['issue']
        def request(issue, **field):
            return {'repository':repository, 'repositoryId':str(native['id']), 'issueId':issue['id'], 'number':issue['number'], 'expectedRevision':issue['revision'], 'idempotencyKey':str(uuid.uuid4()), **field}
        def apply(session, issue, **field):
            payload = request(issue, **field)
            result = rpc(session, 'RepositoryService/UpdateIssue', payload)
            assert result['mutation']['state'] == 'ISSUE_MUTATION_STATE_SUCCEEDED'
            assert result['mutation']['kind'] == 'ISSUE_MUTATION_KIND_UPDATE_ISSUE'
            assert result['mutation']['issueId'] == issue['id'] == result['issue']['id']
            replay = rpc(session, 'RepositoryService/UpdateIssue', payload)
            assert replay['mutation'] == result['mutation']
            return result['issue']
        issue = create(owner, 'Native qualification issue')
        before = issue
        issue = apply(owner, issue, title='Edited title')
        assert issue['title'] == 'Edited title'
        stale = rpc(owner, 'RepositoryService/UpdateIssue', request(before, title='Stale title'))
        assert stale['mutation']['state'] == 'ISSUE_MUTATION_STATE_REJECTED' and stale['mutation']['failureCode'] == 'revision_changed'
        assert read(issue['number'])['title'] == 'Edited title'
        # Repository writer can edit another author's issue; read-unit user cannot.
        issue = apply(writer, read(issue['number'], writer), body='Writer description')
        denied = rpc(reader, 'RepositoryService/UpdateIssue', request(read(issue['number'], reader), title='Denied reader edit'))
        assert denied['mutation']['state'] == 'ISSUE_MUTATION_STATE_REJECTED' and denied['mutation']['failureCode'] == 'provider_http_403'
        rpc(outsider, 'RepositoryService/GetIssue', {'repository':repository, 'number':issue['number']}, expected=404)
        denied = rpc(outsider, 'RepositoryService/UpdateIssue', request(issue, title='Denied outsider'))
        assert denied['mutation']['state'] == 'ISSUE_MUTATION_STATE_REJECTED'
        # A reader can report and then edit their own issue; do not infer rights from push.
        reported = create(reader, 'Reader-authored issue')
        reported = apply(reader, reported, title='Reader edited their own issue')
        reported = apply(reader, reported, state='ISSUE_STATE_CLOSED')
        assert reported['state'] == 'ISSUE_STATE_CLOSED'
        native_before = provider(token, 'GET', path+'/issues/'+str(issue['number']))
        issue = apply(owner, issue, body='')
        assert issue.get('body','') == ''
        native_after = provider(token, 'GET', path+'/issues/'+str(issue['number']))
        assert native_after['body'] == '' and native_after['content_version'] > native_before['content_version']
        provider(token, 'PATCH', path+'/issues/'+str(issue['number']), {'body':'Stale native body', 'content_version':native_before['content_version']}, expected=409)
        assert provider(token, 'GET', path+'/issues/'+str(issue['number']))['body'] == ''
        issue = apply(owner, issue, state='ISSUE_STATE_CLOSED')
        assert issue['state'] == 'ISSUE_STATE_CLOSED'
        issue = apply(owner, issue, state='ISSUE_STATE_OPEN')
        assert issue['state'] == 'ISSUE_STATE_OPEN'
        rpc(owner, 'RepositoryService/UpdateIssue', request(issue, title='Two fields', body='Rejected'), expected=400)
        rpc(owner, 'RepositoryService/UpdateIssue', request(issue, title='Wrong origin'), headers={'Origin':'https://other.invalid'}, expected=403)
        delegation = rpc(owner, 'ApiCredentialService/CreateApiCredential', {'label':'Issue update boundary'})['token']
        rpc(client(), 'RepositoryService/UpdateIssue', request(issue, title='Read-only API denial'), headers={'Authorization':'Bearer '+delegation}, expected=403)
        rpc(owner, 'SessionService/Logout')
        rpc(owner, 'RepositoryService/UpdateIssue', request(issue, title='Logged out'), expected=401)
        assert provider(token, 'GET', path+'/issues/'+str(issue['number']))['title'] == 'Edited title'
        print('PASS: real native title/body/empty-body/close/reopen, owner/writer/author permissions, reader/outsider denial, durable replay, stale revision/native body-version denial, one-field/origin/read-only API/logout boundaries')
    finally:
        for session in sessions:
            try:
                rpc(session, 'SessionService/Logout')
            except Exception:
                pass
        for name in reversed(users):
            admin('delete', '--username', name, '--purge')
        print('Disposable issue qualification users/repository purged.')


if __name__ == '__main__':
    main()
