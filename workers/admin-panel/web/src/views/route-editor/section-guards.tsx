/**
 * "Who may come through" — five independent guards, one accordion card each.
 *
 * An accordion rather than five flat blocks: a newcomer should see the single fact
 * "none of these is on" instead of five sets of inputs they cannot fill. Cards that
 * already hold values start open, because hiding a configured block hides data.
 *
 * On a wide screen this is the top of the right column: everything here may stay
 * empty, and empty is the safe answer.
 */
import { Accordion, AccordionContent, AccordionItem } from '@/components/ui/accordion';
import { AccessKeyGenerator } from './access-key';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
} from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { t } from '@/lib/messages';
import { NUMERIC_BOUNDS } from '@/lib/types';
import { guardsItemSet } from './constants';
import {
  CountryProperty,
  ListProperty,
  NumberProperty,
  SwitchProperty,
  TextProperty,
} from './fields';
import { DangerNote, Hint, SectionCardTrigger } from './parts';
import type { RouteDraft } from './use-route-draft';

export const SectionGuards = ({ draft }: { readonly draft: RouteDraft }) => {
  const {
    definition,
    guardsOpen,
    setGuardsOpen,
    setTopLevel,
    setSectionOn,
    setSectionOff,
    setSectionKey,
    setAccessCloudflareKey,
    forwardAuthReservedRequest,
    forwardAuthReservedResponse,
  } = draft;
  return (
    <>
      {/* 「谁能来」用手风琴而不是平铺：五组守卫各自独立，小白一眼只该看到
                    「都没开」这个事实，而不是五组填不完的输入框。初始只展开已经配过
                    的卡 —— 藏起已配置的区块等于藏起数据；用户收起不丢内容。 */}
      <div className="flex flex-col gap-2">
        <FieldLegend>{t.fields.sections.guards}</FieldLegend>
        <FieldDescription>
          <Hint text={t.fields.sections.guardsHint} />
        </FieldDescription>
      </div>
      <Accordion value={guardsOpen} onValueChange={setGuardsOpen}>
        <AccordionItem value="countries">
          <SectionCardTrigger
            label={t.fields.sections.countries}
            set={guardsItemSet(definition, 'countries')}
            kind="guard"
          />
          <AccordionContent>
            <div className="flex flex-col gap-4">
              <CountryProperty
                id="route-editor-block-countries"
                label={t.fields.blockCountries.label}
                hint={t.fields.blockCountries.help}
                tip={t.fields.blockCountries.tip}
                value={definition.blockCountries}
                onChange={(value) => setTopLevel('blockCountries', value)}
              />
              <CountryProperty
                id="route-editor-allow-countries"
                label={t.fields.allowCountries.label}
                hint={t.fields.allowCountries.help}
                tip={t.fields.allowCountries.tip}
                value={definition.allowCountries}
                onChange={(value) => setTopLevel('allowCountries', value)}
              />
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="cors">
          <SectionCardTrigger
            label={t.fields.cors.label}
            kind="guard"
            set={definition.cors !== undefined}
          />
          <AccordionContent>
            <div className="flex flex-col gap-4">
              <Field orientation="horizontal">
                <Switch
                  id="route-editor-cors"
                  checked={definition.cors !== undefined}
                  onCheckedChange={(checked) =>
                    checked ? setSectionOn('cors') : setSectionOff('cors')
                  }
                />
                <FieldContent>
                  <FieldLabel htmlFor="route-editor-cors">{t.fields.cors.label}</FieldLabel>
                </FieldContent>
              </Field>

              {definition.cors !== undefined && (
                <>
                  <ListProperty
                    id="route-editor-cors-origins"
                    label={t.fields.cors.origins}
                    hint={t.fields.cors.originsHelp}
                    placeholder={t.fields.cors.originsPlaceholder}
                    value={definition.cors.origins}
                    onChange={(value) => setSectionKey('cors', 'origins', value)}
                  />
                  {/* 这一项的危险状态是「缺失」而不是「存在」。 */}
                  {(definition.cors.origins?.length ?? 0) === 0 && (
                    <DangerNote path="cors.origins (absent)" />
                  )}
                  <ListProperty
                    id="route-editor-cors-allow-methods"
                    label={t.fields.cors.allowMethods}
                    hint={t.fields.cors.allowMethodsHelp}
                    placeholder="GET, POST"
                    value={definition.cors.allowMethods}
                    onChange={(value) => setSectionKey('cors', 'allowMethods', value)}
                  />
                  <ListProperty
                    id="route-editor-cors-allow-headers"
                    label={t.fields.cors.allowHeaders}
                    hint={t.fields.cors.allowHeadersHelp}
                    value={definition.cors.allowHeaders}
                    onChange={(value) => setSectionKey('cors', 'allowHeaders', value)}
                  />
                  <ListProperty
                    id="route-editor-cors-expose-headers"
                    label={t.fields.cors.exposeHeaders}
                    hint={t.fields.cors.exposeHeadersHelp}
                    value={definition.cors.exposeHeaders}
                    onChange={(value) => setSectionKey('cors', 'exposeHeaders', value)}
                  />
                  <SwitchProperty
                    id="route-editor-cors-credentials"
                    label={t.fields.cors.credentials}
                    hint={t.fields.cors.credentialsHelp}
                    defaultNote={t.common.defaultValue('false')}
                    checked={definition.cors.credentials === true}
                    onCheckedChange={(checked) =>
                      // 默认 false：等于默认值不落键，段壳保留。
                      setSectionKey('cors', 'credentials', checked ? true : undefined)
                    }
                  />
                  <NumberProperty
                    id="route-editor-cors-max-age"
                    label={t.fields.cors.maxAge}
                    unit="秒"
                    hint={t.fields.cors.maxAgeHelp}
                    value={
                      definition.cors.maxAge === undefined ? '' : String(definition.cors.maxAge)
                    }
                    min={0}
                    onChange={(raw) => {
                      // schema 只要求非负整数；没有上限常量就不假装有，交给服务端判。
                      const next = raw === '' ? undefined : Number(raw);
                      setSectionKey(
                        'cors',
                        'maxAge',
                        next !== undefined &&
                          (Number.isNaN(next) || !Number.isInteger(next) || next < 0)
                          ? undefined
                          : next,
                      );
                    }}
                  />
                </>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="ip">
          <SectionCardTrigger
            label={t.fields.ip.label}
            kind="guard"
            set={definition.ip !== undefined}
          />
          <AccordionContent>
            <div className="flex flex-col gap-4">
              <Field orientation="horizontal">
                <Switch
                  id="route-editor-ip"
                  checked={definition.ip !== undefined}
                  onCheckedChange={(checked) =>
                    checked ? setSectionOn('ip') : setSectionOff('ip')
                  }
                />
                <FieldContent>
                  <FieldLabel htmlFor="route-editor-ip">{t.fields.ip.label}</FieldLabel>
                </FieldContent>
              </Field>

              {definition.ip !== undefined && (
                <>
                  <ListProperty
                    id="route-editor-ip-allow"
                    label={t.fields.ip.allow}
                    hint={t.fields.ip.allowHelp}
                    tip={t.fields.ip.tip}
                    value={definition.ip.allow}
                    onChange={(value) => setSectionKey('ip', 'allow', value)}
                  />
                  {(definition.ip.allow?.length ?? 0) > 0 && <DangerNote path="ip.allow" />}
                  <ListProperty
                    id="route-editor-ip-deny"
                    label={t.fields.ip.deny}
                    hint={t.fields.ip.denyHelp}
                    tip={t.fields.ip.tip}
                    value={definition.ip.deny}
                    onChange={(value) => setSectionKey('ip', 'deny', value)}
                  />
                  {(definition.ip.deny?.length ?? 0) > 0 && <DangerNote path="ip.deny" />}
                </>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="access">
          <SectionCardTrigger
            label={t.fields.access.label}
            kind="guard"
            set={definition.access !== undefined}
          />
          <AccordionContent>
            <div className="flex flex-col gap-4">
              <Field orientation="horizontal">
                <Switch
                  id="route-editor-access"
                  checked={definition.access !== undefined}
                  onCheckedChange={(checked) =>
                    checked ? setSectionOn('access') : setSectionOff('access')
                  }
                />
                <FieldContent>
                  <FieldLabel htmlFor="route-editor-access">{t.fields.access.label}</FieldLabel>
                </FieldContent>
              </Field>

              {definition.access !== undefined && (
                <>
                  <p className="text-muted-foreground text-xs">{t.fields.access.hint}</p>

                  <Field orientation="horizontal">
                    <Switch
                      id="route-editor-access-cf"
                      checked={definition.access.cloudflare !== undefined}
                      onCheckedChange={(checked) =>
                        setSectionKey(
                          'access',
                          'cloudflare',
                          // `cloudflare: {}` 与 ip: {} 一样是半成品草稿：audience
                          // 必填这条由服务端在发布前指出。
                          checked ? {} : undefined,
                        )
                      }
                    />
                    <FieldContent>
                      <FieldLabel htmlFor="route-editor-access-cf">
                        {t.fields.access.cfEnable}
                      </FieldLabel>
                    </FieldContent>
                  </Field>

                  {definition.access.cloudflare !== undefined && (
                    <>
                      <TextProperty
                        id="route-editor-access-team"
                        label={t.fields.access.team}
                        hint={t.fields.access.teamHelp}
                        value={definition.access.cloudflare.team ?? ''}
                        mono
                        onChange={(value) =>
                          setAccessCloudflareKey('team', value === '' ? undefined : value)
                        }
                      />
                      <TextProperty
                        id="route-editor-access-audience"
                        label={t.fields.access.audience}
                        hint={t.fields.access.audienceHelp}
                        tip={t.fields.access.audienceTip}
                        value={definition.access.cloudflare.audience ?? ''}
                        mono
                        onChange={(value) =>
                          setAccessCloudflareKey('audience', value === '' ? undefined : value)
                        }
                      />
                      <ListProperty
                        id="route-editor-access-emails"
                        label={t.fields.access.emails}
                        hint={t.fields.access.emailsHelp}
                        placeholder={t.fields.access.emailsPlaceholder}
                        value={definition.access.cloudflare.emails}
                        onChange={(value) => setAccessCloudflareKey('emails', value)}
                      />
                    </>
                  )}

                  <ListProperty
                    id="route-editor-access-keys"
                    label={t.fields.access.keys}
                    hint={t.fields.access.keysHelp}
                    placeholder={t.fields.access.keysPlaceholder}
                    value={definition.access.keys}
                    onChange={(value) => setSectionKey('access', 'keys', value)}
                  />
                  <AccessKeyGenerator
                    onDigest={(digest) =>
                      setSectionKey('access', 'keys', [...(definition.access?.keys ?? []), digest])
                    }
                  />
                  {(definition.access.keys?.length ?? 0) > 0 && <DangerNote path="access.keys" />}

                  <TextProperty
                    id="route-editor-access-header"
                    label={t.fields.access.header}
                    hint={t.fields.access.headerHelp}
                    value={definition.access.header ?? ''}
                    mono
                    onChange={(value) =>
                      setSectionKey('access', 'header', value === '' ? undefined : value)
                    }
                  />
                </>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>

        <AccordionItem value="forwardAuth">
          <SectionCardTrigger
            label={t.fields.forwardAuth.label}
            kind="guard"
            set={definition.forwardAuth !== undefined}
            needsFix={
              forwardAuthReservedRequest.length > 0 || forwardAuthReservedResponse.length > 0
            }
          />
          <AccordionContent>
            <div className="flex flex-col gap-4">
              <Field orientation="horizontal">
                <Switch
                  id="route-editor-forward-auth"
                  checked={definition.forwardAuth !== undefined}
                  onCheckedChange={(checked) =>
                    checked ? setSectionOn('forwardAuth') : setSectionOff('forwardAuth')
                  }
                />
                <FieldContent>
                  <FieldLabel htmlFor="route-editor-forward-auth">
                    {t.fields.forwardAuth.label}
                  </FieldLabel>
                </FieldContent>
              </Field>

              {definition.forwardAuth !== undefined && (
                <>
                  <TextProperty
                    id="route-editor-forward-auth-url"
                    label={t.fields.forwardAuth.url}
                    hint={t.fields.forwardAuth.urlHelp}
                    value={definition.forwardAuth.url ?? ''}
                    mono
                    onChange={(value) =>
                      setSectionKey('forwardAuth', 'url', value === '' ? undefined : value)
                    }
                  />
                  {/* 只有明文方案才值得警示，与 danger.ts 的 guard 同口径。 */}
                  {(definition.forwardAuth.url?.startsWith('http://') ?? false) && (
                    <DangerNote path="forwardAuth.url" />
                  )}
                  <ListProperty
                    id="route-editor-forward-auth-request-headers"
                    label={t.fields.forwardAuth.copyRequestHeaders}
                    hint={t.fields.forwardAuth.copyRequestHeadersHelp}
                    value={definition.forwardAuth.copyRequestHeaders}
                    onChange={(value) => setSectionKey('forwardAuth', 'copyRequestHeaders', value)}
                  />
                  {forwardAuthReservedRequest.length > 0 && (
                    <FieldError>
                      {t.fields.forwardAuth.reserved(forwardAuthReservedRequest.join(', '))}
                    </FieldError>
                  )}
                  <ListProperty
                    id="route-editor-forward-auth-response-headers"
                    label={t.fields.forwardAuth.copyResponseHeaders}
                    hint={t.fields.forwardAuth.copyResponseHeadersHelp}
                    value={definition.forwardAuth.copyResponseHeaders}
                    onChange={(value) => setSectionKey('forwardAuth', 'copyResponseHeaders', value)}
                  />
                  {forwardAuthReservedResponse.length > 0 && (
                    <FieldError>
                      {t.fields.forwardAuth.reserved(forwardAuthReservedResponse.join(', '))}
                    </FieldError>
                  )}
                  <NumberProperty
                    id="route-editor-forward-auth-timeout"
                    label={t.fields.forwardAuth.timeoutMs}
                    unit="毫秒"
                    hint={t.fields.forwardAuth.timeoutMsHelp}
                    value={
                      definition.forwardAuth.timeoutMs === undefined
                        ? ''
                        : String(definition.forwardAuth.timeoutMs)
                    }
                    min={NUMERIC_BOUNDS.authTimeoutMs.min}
                    max={NUMERIC_BOUNDS.authTimeoutMs.max}
                    onChange={(raw) => {
                      const next = raw === '' ? undefined : Number(raw);
                      setSectionKey(
                        'forwardAuth',
                        'timeoutMs',
                        next !== undefined &&
                          (Number.isNaN(next) ||
                            !Number.isInteger(next) ||
                            next < NUMERIC_BOUNDS.authTimeoutMs.min ||
                            next > NUMERIC_BOUNDS.authTimeoutMs.max)
                          ? undefined
                          : next,
                      );
                    }}
                  />
                  <SwitchProperty
                    id="route-editor-forward-auth-fail-open"
                    label={t.fields.forwardAuth.failOpen}
                    hint={t.fields.forwardAuth.failOpenHelp}
                    defaultNote={t.fields.forwardAuth.failOpenDefault}
                    checked={definition.forwardAuth.failOpen === true}
                    onCheckedChange={(checked) =>
                      setSectionKey('forwardAuth', 'failOpen', checked ? true : undefined)
                    }
                  />
                  {definition.forwardAuth.failOpen === true && (
                    <DangerNote path="forwardAuth.failOpen" />
                  )}
                </>
              )}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>
  );
};
