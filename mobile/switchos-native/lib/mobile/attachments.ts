import * as ImagePicker from "expo-image-picker";

import type { AttachmentDraft } from "@/lib/mobile/types";

export async function pickPhotoAttachment(): Promise<AttachmentDraft | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [4, 3],
    quality: 0.7,
  });

  if (result.canceled || !result.assets[0]) {
    return null;
  }

  const asset = result.assets[0];
  return {
    id: `attachment-${Date.now()}`,
    uri: asset.uri,
    name: asset.fileName ?? `photo-${Date.now()}.jpg`,
    mimeType: asset.mimeType,
  };
}
