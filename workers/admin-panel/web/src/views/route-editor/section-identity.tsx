/**
 * Route identity: the ID and the enabled switch.
 *
 * Lives outside the form/JSON tabs on purpose — neither field is part of the route
 * definition, so both stay editable while the operator is writing raw JSON.
 */
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { t } from '@/lib/messages';
import { Hint } from './parts';
import type { RouteDraft } from './use-route-draft';

export const SectionIdentity = ({ draft }: { readonly draft: RouteDraft }) => {
  const { createMode, id, setId, setFormTouched, shownErrors, enabled, setEnabled } = draft;
  return (
    <FieldSet>
      <FieldLegend>{t.fields.sections.identity}</FieldLegend>
      <FieldDescription>
        <Hint text={t.fields.sections.identityHint} />
      </FieldDescription>

      <Field data-invalid={shownErrors.id !== undefined ? true : undefined}>
        <FieldLabel htmlFor="route-editor-id">{t.editor.idLabel}</FieldLabel>
        {createMode ? (
          <Input
            id="route-editor-id"
            className="font-mono"
            value={id}
            aria-invalid={shownErrors.id !== undefined}
            onChange={(event) => {
              setFormTouched(true);
              setId(event.target.value);
            }}
          />
        ) : (
          <Input id="route-editor-id" className="font-mono" value={id} readOnly />
        )}
        <FieldDescription>
          <Hint text={createMode ? t.editor.idHint : t.editor.idImmutable} />
        </FieldDescription>
        {shownErrors.id !== undefined && <FieldError>{shownErrors.id}</FieldError>}
      </Field>

      <Field orientation="horizontal">
        <Switch
          id="route-editor-enabled"
          checked={enabled}
          onCheckedChange={(checked) => {
            setFormTouched(true);
            setEnabled(checked);
          }}
        />
        <FieldContent>
          <FieldLabel htmlFor="route-editor-enabled">{t.editor.enabledLabel}</FieldLabel>
          <FieldDescription>
            <Hint text={t.editor.enabledHint} />
          </FieldDescription>
        </FieldContent>
      </Field>
    </FieldSet>
  );
};
