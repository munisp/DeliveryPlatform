import { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import Svg, { Line, Text as SvgText } from "react-native-svg";

import type { AnnotationStroke, AnnotationText, AttachmentDraft } from "@/lib/mobile/types";

type PhotoAnnotationSheetProps = {
  visible: boolean;
  attachment: AttachmentDraft | null;
  onClose: () => void;
  onSave: (attachment: AttachmentDraft) => void;
};

const palette = ["#F97316", "#22C55E", "#38BDF8", "#FACC15", "#F43F5E", "#FFFFFF"];

function createStroke(color: string): AnnotationStroke {
  return {
    id: `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    color,
    width: 3,
    points: [],
  };
}

export function PhotoAnnotationSheet({ visible, attachment, onClose, onSave }: PhotoAnnotationSheetProps) {
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([]);
  const [texts, setTexts] = useState<AnnotationText[]>([]);
  const [activeColor, setActiveColor] = useState(palette[0]);
  const [textDraft, setTextDraft] = useState("");
  const activeStrokeRef = useRef<AnnotationStroke | null>(null);

  useEffect(() => {
    if (!attachment) {
      setStrokes([]);
      setTexts([]);
      setTextDraft("");
      return;
    }

    setStrokes(attachment.annotations?.strokes ?? []);
    setTexts(attachment.annotations?.texts ?? []);
    setTextDraft("");
  }, [attachment]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => Boolean(attachment),
        onMoveShouldSetPanResponder: () => Boolean(attachment),
        onPanResponderGrant: (event) => {
          const stroke = createStroke(activeColor);
          stroke.points.push({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY });
          activeStrokeRef.current = stroke;
          setStrokes((current) => [...current, stroke]);
        },
        onPanResponderMove: (event) => {
          const stroke = activeStrokeRef.current;
          if (!stroke) {
            return;
          }
          stroke.points.push({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY });
          setStrokes((current) => current.map((item) => (item.id === stroke.id ? { ...stroke } : item)));
        },
        onPanResponderRelease: () => {
          activeStrokeRef.current = null;
        },
        onPanResponderTerminate: () => {
          activeStrokeRef.current = null;
        },
      }),
    [activeColor, attachment],
  );

  if (!attachment) {
    return null;
  }

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <View className="flex-1 bg-black/60 px-4 py-8">
        <View className="mt-auto rounded-[28px] border border-border bg-background px-4 py-4">
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-1">
              <Text className="text-lg font-semibold text-foreground">Annotate evidence</Text>
              <Text className="mt-1 text-sm leading-6 text-muted">Draw directly on the image or add short text labels before saving the evidence copy.</Text>
            </View>
            <Pressable onPress={onClose} className="rounded-full bg-surface px-3 py-2">
              <Text className="text-xs font-semibold text-foreground">Close</Text>
            </Pressable>
          </View>

          <View className="mt-4 overflow-hidden rounded-[24px] border border-border bg-surface">
            <View {...panResponder.panHandlers} style={{ height: 280, position: "relative" }}>
              <Image source={{ uri: attachment.uri }} style={{ height: 280, width: "100%" }} contentFit="cover" />
              <Svg pointerEvents="none" width="100%" height="280" style={{ position: "absolute", left: 0, top: 0 }}>
                {strokes.flatMap((stroke) =>
                  stroke.points.slice(1).map((point, index) => {
                    const previous = stroke.points[index];
                    return (
                      <Line
                        key={`${stroke.id}-${index}`}
                        x1={previous?.x ?? point.x}
                        y1={previous?.y ?? point.y}
                        x2={point.x}
                        y2={point.y}
                        stroke={stroke.color}
                        strokeWidth={stroke.width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    );
                  }),
                )}
                {texts.map((label) => (
                  <SvgText key={label.id} x={label.x} y={label.y} fill={label.color} fontSize="16" fontWeight="700">
                    {label.text}
                  </SvgText>
                ))}
              </Svg>
            </View>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingTop: 16 }}>
            {palette.map((color) => (
              <Pressable
                key={color}
                onPress={() => setActiveColor(color)}
                style={{ backgroundColor: color, width: 36, height: 36, borderRadius: 18, borderWidth: activeColor === color ? 3 : 1, borderColor: activeColor === color ? "#ffffff" : "#334155" }}
              />
            ))}
          </ScrollView>

          <TextInput
            value={textDraft}
            onChangeText={setTextDraft}
            placeholder="Add a text note to the image"
            placeholderTextColor="#6B7F97"
            className="mt-4 rounded-[18px] border border-border bg-surface px-4 py-3 text-sm text-foreground"
          />

          <View className="mt-3 flex-row flex-wrap gap-3">
            <Pressable
              onPress={() => {
                if (!textDraft.trim()) {
                  return;
                }
                setTexts((current) => [
                  ...current,
                  {
                    id: `text-${Date.now()}`,
                    text: textDraft.trim(),
                    color: activeColor,
                    x: 24,
                    y: 32 + current.length * 22,
                  },
                ]);
                setTextDraft("");
              }}
              className="rounded-full bg-primary px-4 py-3"
            >
              <Text className="text-xs font-semibold text-white">Add text label</Text>
            </Pressable>
            <Pressable onPress={() => setStrokes((current) => current.slice(0, -1))} className="rounded-full bg-surface px-4 py-3">
              <Text className="text-xs font-semibold text-foreground">Undo stroke</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setStrokes([]);
                setTexts([]);
                setTextDraft("");
              }}
              className="rounded-full bg-surface px-4 py-3"
            >
              <Text className="text-xs font-semibold text-foreground">Clear all</Text>
            </Pressable>
          </View>

          <Pressable
            onPress={() =>
              onSave({
                ...attachment,
                annotations: {
                  strokes,
                  texts,
                  width: 1000,
                  height: 280,
                  annotatedAt: new Date().toISOString(),
                },
              })
            }
            className="mt-4 rounded-full bg-primary px-4 py-3"
          >
            <Text className="text-center text-xs font-semibold text-white">Save annotated evidence</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
