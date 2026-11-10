import { Image } from "expo-image";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import {
  Notice,
  StatusPill,
  trustInputClass,
  trustPlaceholderColor,
} from "@/components/trust/ui";
import { useColors } from "@/hooks/use-colors";
import {
  CONDITION_GRADES,
  PHOTO_ZONES,
  captureZonePhoto,
  newIdempotencyKey,
  useRecordConditionReport,
  type CapturedZonePhoto,
  type ConditionGrade,
  type ConditionPhase,
  type ConditionPhotoInput,
  type PhotoZone,
} from "@/lib/rentalCondition";

/**
 * Rental condition evidence form (check-out before handover, check-in before
 * return settlement). Photos are captured live, hashed (sha256), uploaded to
 * the object store, and submitted as evidence on rentalCondition.recordReport.
 *
 * The dashboard/odometer zone is REQUIRED — the server rejects reports
 * without it, so the submit button stays disabled until that photo exists.
 * Reports are append-only: one per contract + phase, replayed safely through
 * the generated idempotency key.
 */

type ZonePhotoState = CapturedZonePhoto & {
  damageFlag: boolean;
  note: string;
};

export type CapturePhotoFn = (
  zone: PhotoZone,
) => Promise<CapturedZonePhoto | null>;

export type ConditionReportFormProps = {
  contractId: string;
  phase: ConditionPhase;
  onSubmitted?: (reportId: string) => void;
  /**
   * Photo capture pipeline. Defaults to live camera capture + sha256 +
   * object-store upload (lib/rentalCondition.captureZonePhoto). Injectable so
   * flows that already hold pre-uploaded {objectKey, sha256Hex} evidence can
   * supply it directly.
   */
  capturePhoto?: CapturePhotoFn;
};

function parseNonNegativeInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function ZonePhotoCard({
  spec,
  photo,
  capturing,
  disabled,
  onCapture,
  onRemove,
  onToggleDamage,
  onChangeNote,
}: {
  spec: { zone: PhotoZone; label: string; required: boolean };
  photo: ZonePhotoState | undefined;
  capturing: boolean;
  disabled: boolean;
  onCapture: () => void;
  onRemove: () => void;
  onToggleDamage: () => void;
  onChangeNote: (note: string) => void;
}) {
  const colors = useColors();
  return (
    <View className="gap-2 rounded-[20px] border border-border bg-background/60 px-3 py-3">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-sm font-semibold text-foreground">
          {spec.label}
        </Text>
        {spec.required ? (
          <StatusPill label="Required" tone="error" />
        ) : photo ? (
          <StatusPill label="Captured" tone="success" />
        ) : (
          <StatusPill label="Optional" tone="neutral" />
        )}
      </View>

      {photo ? (
        <View className="gap-2">
          <View className="flex-row items-center gap-3">
            <Image
              source={{ uri: photo.previewUri }}
              style={{ width: 64, height: 64, borderRadius: 12 }}
              contentFit="cover"
            />
            <View className="flex-1">
              <Text className="text-xs text-muted" numberOfLines={1}>
                {photo.objectKey}
              </Text>
              <Text className="mt-1 font-mono text-[10px] text-muted">
                sha256 {photo.sha256Hex.slice(0, 16)}…
              </Text>
            </View>
          </View>
          <View className="flex-row flex-wrap gap-2">
            <Pressable
              onPress={onToggleDamage}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`Toggle damage flag for ${spec.label}`}
              className={`rounded-full border px-3 py-2 ${
                photo.damageFlag
                  ? "border-error/50 bg-error/15"
                  : "border-border bg-surface"
              }`}
            >
              <Text
                className={`text-xs font-semibold ${
                  photo.damageFlag ? "text-error" : "text-foreground"
                }`}
              >
                {photo.damageFlag ? "Damage flagged" : "Flag damage"}
              </Text>
            </Pressable>
            <Pressable
              onPress={onCapture}
              disabled={disabled || capturing}
              accessibilityRole="button"
              accessibilityLabel={`Retake ${spec.label} photo`}
              className="rounded-full border border-border bg-surface px-3 py-2"
            >
              <Text className="text-xs font-semibold text-foreground">
                Retake
              </Text>
            </Pressable>
            <Pressable
              onPress={onRemove}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${spec.label} photo`}
              className="rounded-full border border-border bg-surface px-3 py-2"
            >
              <Text className="text-xs font-semibold text-error">Remove</Text>
            </Pressable>
          </View>
          {photo.damageFlag ? (
            <TextInput
              value={photo.note}
              onChangeText={onChangeNote}
              placeholder="Describe the damage (optional)"
              placeholderTextColor={trustPlaceholderColor}
              maxLength={500}
              editable={!disabled}
              className={trustInputClass}
            />
          ) : null}
        </View>
      ) : (
        <Pressable
          onPress={onCapture}
          disabled={disabled || capturing}
          accessibilityRole="button"
          accessibilityLabel={`Capture ${spec.label} photo`}
          className="flex-row items-center justify-center gap-2 rounded-full bg-primary px-4 py-3"
          style={({ pressed }) => ({
            opacity: pressed || disabled || capturing ? 0.6 : 1,
          })}
        >
          {capturing ? (
            <ActivityIndicator size="small" color={colors.background} />
          ) : null}
          <Text className="text-xs font-semibold text-white">
            {capturing ? "Capturing…" : "Capture photo"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export function ConditionReportForm({
  contractId,
  phase,
  onSubmitted,
  capturePhoto,
}: ConditionReportFormProps) {
  const colors = useColors();
  const recordReport = useRecordConditionReport();

  const [odometerText, setOdometerText] = useState("");
  const [fuelText, setFuelText] = useState("");
  const [overallCondition, setOverallCondition] =
    useState<ConditionGrade | null>(null);
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<Partial<Record<PhotoZone, ZonePhotoState>>>(
    {},
  );
  const [capturingZone, setCapturingZone] = useState<PhotoZone | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submittedReportId, setSubmittedReportId] = useState<string | null>(
    null,
  );

  // One idempotency key per form attempt: regenerated after a successful
  // submit so a follow-up correction attempt is a distinct operation.
  const idempotencyKeyRef = useRef(newIdempotencyKey("condition-report"));

  const defaultCapture = useCallback<CapturePhotoFn>(
    (zone) => captureZonePhoto(zone, { contractId, phase }),
    [contractId, phase],
  );
  const capture = capturePhoto ?? defaultCapture;

  const updatePhoto = (
    zone: PhotoZone,
    updater: (current: ZonePhotoState | undefined) => ZonePhotoState | undefined,
  ) =>
    setPhotos((current) => {
      const next = { ...current };
      const value = updater(next[zone]);
      if (value === undefined) {
        delete next[zone];
      } else {
        next[zone] = value;
      }
      return next;
    });

  const handleCapture = async (zone: PhotoZone) => {
    setCapturingZone(zone);
    setCaptureError(null);
    try {
      const result = await capture(zone);
      if (result) {
        updatePhoto(zone, (current) => ({
          ...result,
          damageFlag: current?.damageFlag ?? false,
          note: current?.note ?? "",
        }));
      }
    } catch (error) {
      setCaptureError(
        error instanceof Error ? error.message : "Photo capture failed",
      );
    } finally {
      setCapturingZone(null);
    }
  };

  const odometerKm = useMemo(() => parseNonNegativeInt(odometerText), [odometerText]);
  const fuelPct = useMemo(() => {
    const parsed = parseNonNegativeInt(fuelText);
    return parsed !== null && parsed <= 100 ? parsed : null;
  }, [fuelText]);

  const odometerPhoto = photos.dashboard_odometer;
  const capturedCount = Object.keys(photos).length;

  const validate = (): string | null => {
    if (odometerKm === null) {
      return "Enter the odometer reading in whole kilometres (0 or more).";
    }
    if (fuelPct === null) {
      return "Enter the fuel level as a whole percentage between 0 and 100.";
    }
    if (!overallCondition) {
      return "Select the overall vehicle condition.";
    }
    if (notes.trim().length > 0 && notes.trim().length < 3) {
      return "Notes must be at least 3 characters, or left empty.";
    }
    if (!odometerPhoto) {
      return "The dashboard/odometer photo is required before submitting.";
    }
    for (const spec of PHOTO_ZONES) {
      const photo = photos[spec.zone];
      if (
        photo?.damageFlag &&
        photo.note.trim().length > 0 &&
        photo.note.trim().length < 3
      ) {
        return `The damage note for ${spec.label} must be at least 3 characters.`;
      }
    }
    return null;
  };

  const submit = () => {
    const problem = validate();
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    const photoInputs: ConditionPhotoInput[] = PHOTO_ZONES.flatMap((spec) => {
      const photo = photos[spec.zone];
      if (!photo) return [];
      const note = photo.note.trim();
      return [
        {
          zone: photo.zone,
          objectKey: photo.objectKey,
          contentType: photo.contentType,
          sha256Hex: photo.sha256Hex,
          damageFlag: photo.damageFlag,
          ...(photo.damageFlag && note ? { note } : {}),
        },
      ];
    });
    const trimmedNotes = notes.trim();
    recordReport.mutate(
      {
        contractId,
        phase,
        odometerKm: odometerKm ?? 0,
        fuelPct: fuelPct ?? 0,
        overallCondition: overallCondition ?? "good",
        ...(trimmedNotes ? { notes: trimmedNotes } : {}),
        photos: photoInputs,
        idempotencyKey: idempotencyKeyRef.current,
      },
      {
        onSuccess: (reportId) => {
          setSubmittedReportId(reportId);
          idempotencyKeyRef.current = newIdempotencyKey("condition-report");
          onSubmitted?.(reportId);
        },
        onError: (error) => setFormError(error.message),
      },
    );
  };

  const busy = recordReport.isPending || capturingZone !== null;

  if (submittedReportId) {
    return (
      <SectionCard
        title={phase === "check_out" ? "Check-out recorded" : "Check-in recorded"}
        subtitle={`Report ${submittedReportId}`}
      >
        <Notice
          tone="success"
          title="Condition report stored"
          body={
            phase === "check_out"
              ? "The vehicle can now be handed over. The report and its photo evidence are append-only."
              : "The return evidence is recorded. An operator can now compute the return settlement."
          }
        />
      </SectionCard>
    );
  }

  return (
    <View className="gap-4">
      <SectionCard
        title="Vehicle readings"
        subtitle="Record the odometer and fuel level exactly as shown on the dashboard photo."
      >
        <View className="flex-row gap-3">
          <View className="flex-1 gap-1">
            <Text className="text-xs uppercase tracking-wide text-muted">
              Odometer (km)
            </Text>
            <TextInput
              value={odometerText}
              onChangeText={setOdometerText}
              placeholder="e.g. 45210"
              placeholderTextColor={trustPlaceholderColor}
              keyboardType="number-pad"
              editable={!busy}
              className={trustInputClass}
            />
          </View>
          <View className="flex-1 gap-1">
            <Text className="text-xs uppercase tracking-wide text-muted">
              Fuel (0–100%)
            </Text>
            <TextInput
              value={fuelText}
              onChangeText={setFuelText}
              placeholder="e.g. 80"
              placeholderTextColor={trustPlaceholderColor}
              keyboardType="number-pad"
              maxLength={3}
              editable={!busy}
              className={trustInputClass}
            />
          </View>
        </View>
        {odometerText.trim() !== "" && odometerKm === null ? (
          <Text className="text-xs text-error">
            Odometer must be a whole number of kilometres.
          </Text>
        ) : null}
        {fuelText.trim() !== "" && fuelPct === null ? (
          <Text className="text-xs text-error">
            Fuel must be a whole percentage from 0 to 100.
          </Text>
        ) : null}
      </SectionCard>

      <SectionCard
        title="Overall condition"
        subtitle="Your honest grade anchors the damage assessment at return."
      >
        <View className="flex-row flex-wrap gap-2">
          {CONDITION_GRADES.map((grade) => {
            const selected = overallCondition === grade;
            return (
              <Pressable
                key={grade}
                onPress={() => setOverallCondition(grade)}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={`Overall condition ${grade}`}
                className={`rounded-full border px-4 py-2 ${
                  selected
                    ? "border-primary bg-primary/15"
                    : "border-border bg-surface"
                }`}
              >
                <Text
                  className={`text-xs font-semibold capitalize ${
                    selected ? "text-primary" : "text-foreground"
                  }`}
                >
                  {grade}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </SectionCard>

      <SectionCard
        title="Photo checklist"
        subtitle={`${capturedCount} of ${PHOTO_ZONES.length} zones captured. The dashboard/odometer photo is required; flag any new damage on the relevant zone.`}
      >
        {PHOTO_ZONES.map((spec) => (
          <ZonePhotoCard
            key={spec.zone}
            spec={spec}
            photo={photos[spec.zone]}
            capturing={capturingZone === spec.zone}
            disabled={busy}
            onCapture={() => void handleCapture(spec.zone)}
            onRemove={() => updatePhoto(spec.zone, () => undefined)}
            onToggleDamage={() =>
              updatePhoto(spec.zone, (current) =>
                current
                  ? { ...current, damageFlag: !current.damageFlag }
                  : current,
              )
            }
            onChangeNote={(note) =>
              updatePhoto(spec.zone, (current) =>
                current ? { ...current, note } : current,
              )
            }
          />
        ))}
        {captureError ? (
          <Notice tone="error" title="Photo capture failed" body={captureError} />
        ) : null}
      </SectionCard>

      <SectionCard
        title="Notes"
        subtitle="Anything the operator should know (optional, 3–1000 characters)."
      >
        <TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder="e.g. Spare wheel missing from the boot"
          placeholderTextColor={trustPlaceholderColor}
          multiline
          maxLength={1000}
          editable={!busy}
          className={`${trustInputClass} min-h-[72px]`}
        />
      </SectionCard>

      {formError ? (
        <Notice tone="error" title="Cannot submit report" body={formError} />
      ) : null}

      <Pressable
        onPress={submit}
        disabled={busy || !odometerPhoto}
        accessibilityRole="button"
        accessibilityLabel={
          phase === "check_out"
            ? "Submit check-out report"
            : "Submit check-in report"
        }
        className="items-center rounded-full bg-primary px-4 py-4"
        style={({ pressed }) => ({
          opacity: pressed || busy || !odometerPhoto ? 0.6 : 1,
        })}
      >
        {recordReport.isPending ? (
          <ActivityIndicator size="small" color={colors.background} />
        ) : (
          <Text className="text-sm font-semibold text-white">
            {phase === "check_out"
              ? "Submit check-out report"
              : "Submit check-in report"}
          </Text>
        )}
      </Pressable>
      {!odometerPhoto ? (
        <Text className="text-center text-xs text-muted">
          Capture the dashboard/odometer photo to enable submission.
        </Text>
      ) : null}
    </View>
  );
}
