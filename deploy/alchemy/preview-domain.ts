import * as Workers from '@distilled.cloud/cloudflare/workers';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Provider from 'alchemy/Provider';
import { Resource } from 'alchemy/Resource';
import { CloudflareApiLive } from 'alchemy/Cloudflare';
import { ownedDomain } from './native-config.mjs';

interface Domain extends Resource<'Golf.PreviewDomain', {
  accountId: string; hostname: string; service: string; zoneId: string;
}, { id: string; accountId: string; hostname: string; service: string; zoneId: string }> {}
export const PreviewDomain = Resource<Domain>('Golf.PreviewDomain');

// Worker.domain reconciles every attached hostname, including Golf's live apps.
// Own only this exact gateway domain; runtime preview domains keep their journal.
export const previewDomainProvider = () => Provider.succeed(PreviewDomain, {
  diff: () => Effect.succeed({ action: 'update' as const }),
  reconcile: Effect.fn(function* ({ news }) {
    const listed = yield* Workers.listDomains({ accountId: news.accountId, hostname: news.hostname });
    const current = ownedDomain(listed.result ?? [], news);
    const domain = current ?? (yield* Workers.putDomain(news));
    const confirmed = ownedDomain([domain], news);
    if (!confirmed?.id) return yield* Effect.fail(new Error('Preview domain allocation unconfirmed'));
    return { ...news, id: confirmed.id };
  }),
  delete: Effect.fn(function* ({ output }) {
    const current = yield* Workers.getDomain({ accountId: output.accountId, domainId: output.id })
      .pipe(Effect.catchTag('DomainNotFound', () => Effect.succeed(undefined)));
    if (!current) return;
    if (!ownedDomain([current], output) || current.id !== output.id)
      return yield* Effect.fail(new Error('Preview domain ownership differs'));
    yield* Workers.deleteDomain({ accountId: output.accountId, domainId: output.id });
  }),
}).pipe(Layer.provide(CloudflareApiLive()), Layer.orDie);
