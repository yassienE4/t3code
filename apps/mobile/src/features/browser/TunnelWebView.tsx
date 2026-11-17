import type { EnvironmentId } from "@t3tools/contracts";
import { requireNativeModule, requireNativeView } from "expo";
import type { Ref } from "react";
import { StyleSheet, View, type NativeSyntheticEvent, type ViewProps } from "react-native";

import { readPreviewTunnelUrl } from "../../state/previewTunnel";

export interface TunnelNavigation {
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

export interface TunnelWebViewRef {
  readonly goBack: () => Promise<void>;
  readonly goForward: () => Promise<void>;
  readonly reload: () => Promise<void>;
}

const PreviewTunnel = requireNativeModule<{
  resolveAccess(requestId: string, url: string | null): void;
}>("T3PreviewTunnel");

const NativeTunnelWebView = requireNativeView<
  ViewProps & {
    readonly ref?: Ref<TunnelWebViewRef>;
    readonly url: string;
    readonly onAccessRequest: (event: NativeSyntheticEvent<{ requestId: string }>) => void;
    readonly onNavigationChange: (event: NativeSyntheticEvent<TunnelNavigation>) => void;
    readonly onLoadError: (
      event: NativeSyntheticEvent<{ code: number; description: string }>,
    ) => void;
  }
>("T3PreviewTunnel");

/** A native webview whose localhost is the environment's loopback, reached through its tunnel. */
export function TunnelWebView({
  environmentId,
  url,
  ref,
  onNavigationChange,
  onLoadError,
  ...props
}: ViewProps & {
  readonly environmentId: EnvironmentId;
  readonly url: string;
  readonly ref?: Ref<TunnelWebViewRef>;
  readonly onNavigationChange: (navigation: TunnelNavigation) => void;
  readonly onLoadError: () => void;
}) {
  // Styling goes on a plain View: a native view from `requireNativeView` ignores className.
  return (
    <View {...props}>
      <NativeTunnelWebView
        style={StyleSheet.absoluteFill}
        ref={ref}
        url={url}
        onAccessRequest={({ nativeEvent }) => {
          void readPreviewTunnelUrl(environmentId).then((tunnelUrl) =>
            PreviewTunnel.resolveAccess(nativeEvent.requestId, tunnelUrl),
          );
        }}
        onNavigationChange={({ nativeEvent }) => onNavigationChange(nativeEvent)}
        onLoadError={() => onLoadError()}
      />
    </View>
  );
}
