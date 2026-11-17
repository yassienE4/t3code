import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { ControlPill } from "../../components/ui/ControlPill";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useContentTopInset } from "../../components/ui/useBarInset";
import { TunnelWebView, type TunnelNavigation, type TunnelWebViewRef } from "./TunnelWebView";

type LocalPreviewRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly url: string;
}>;

/** Another environment's localhost page rendered by this device's own webview. */
export function LocalPreviewRouteScreen({ route }: LocalPreviewRouteScreenProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const contentTopInset = useContentTopInset();
  const webView = useRef<TunnelWebViewRef>(null);
  const [url, setUrl] = useState(route.params.url);
  const [draft, setDraft] = useState<string | null>(null);
  const [page, setPage] = useState<TunnelNavigation | null>(null);
  const [error, setError] = useState(false);

  const submit = () => {
    const value = draft ?? (page?.url || url);
    setDraft(null);
    const next = normalizedOrNull(value);
    if (next === null) {
      Dialog.alert("Could not open this address", "Enter an http or https URL.");
      return;
    }
    setError(false);
    // The prop only changes for a new address; submitting the same one retries it.
    if (next === url) void webView.current?.reload();
    else setUrl(next);
  };

  return (
    <View
      className="flex-1 bg-sheet"
      style={{ paddingTop: contentTopInset, paddingBottom: insets.bottom }}
    >
      <SheetHeader
        title={page?.title || "On this device"}
        onClose={() => navigation.goBack()}
        accessibilityLabel="Close browser"
      />
      <View className="flex-row items-center gap-1 px-2 pb-2">
        <ControlPill
          icon="chevron.left"
          accessibilityLabel="Back"
          disabled={!page?.canGoBack}
          onPress={() => void webView.current?.goBack()}
        />
        <ControlPill
          icon="chevron.right"
          accessibilityLabel="Forward"
          disabled={!page?.canGoForward}
          onPress={() => void webView.current?.goForward()}
        />
        <TextInput
          accessibilityLabel="Address"
          value={draft ?? (page?.url || url)}
          onChangeText={setDraft}
          onBlur={() => setDraft(null)}
          onSubmitEditing={submit}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          selectTextOnFocus
          lineBreakModeIOS="tail"
          className="h-10 min-w-0 flex-1 rounded-full border border-input-border bg-input px-4 font-sans text-sm text-foreground"
        />
        <ControlPill
          icon="arrow.clockwise"
          accessibilityLabel="Reload page"
          onPress={() => {
            setError(false);
            void webView.current?.reload();
          }}
        />
      </View>
      <TunnelWebView
        ref={webView}
        className="flex-1"
        environmentId={EnvironmentId.make(route.params.environmentId)}
        url={url}
        onNavigationChange={(next) => {
          if (next.loading) setError(false);
          setPage(next);
        }}
        onLoadError={() => setError(true)}
      />
      {error ? (
        <View className="absolute inset-x-0 bg-sheet px-4 py-3" style={{ bottom: insets.bottom }}>
          <Text className="font-sans text-sm text-foreground">
            Could not reach this port on the environment.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function normalizedOrNull(value: string): string | null {
  try {
    return normalizePreviewUrl(value);
  } catch {
    return null;
  }
}
