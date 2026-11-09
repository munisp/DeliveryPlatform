# OpenRide Integration — DeliveryPlatform Mobile (Phases 1 & 3)

App-to-app integration between this Expo/React Native driver app and the
OpenRide offline navigation app. Contracts are frozen in
`routeplanner/INTEGRATION_SPEC.md`:

- **C1** — launch OpenRide with a job payload via `openride://job?payload=<base64url(JSON)>`
- **C2** — OpenRide uploads the recorded track summary to
  `POST <upload.url>` (`openrideTelemetry.ingestTrack`) with
  `Authorization: Bearer <upload.token>`; this app only displays the returned status
- **C3** — customer/driver place search via the tRPC `openrideGeo.search` proxy
  (server-hosted OpenRide geocoder service)

## Files

| File | Purpose |
|---|---|
| `lib/openride.ts` | C1 deep-link builder/launcher + `switchos://job-complete` parser |
| `app/job-navigate.tsx` | Launcher screen (expo-router auto-registers `/job-navigate`) |
| `app/job-complete.tsx` | Cold-start landing route for the `switchos://job-complete` return link |
| `components/PlaceSearchField.tsx` | Debounced (300 ms) place search via `trpc.openrideGeo.search.useQuery` |

## Phase 1 — job launch flow

1. A dispatch/delivery screen links to
   `/job-navigate?jobId=<uuid>&kind=ride|delivery&bundleCity=lagos`
   `&pickupLat=..&pickupLon=..[&pickupAddress=..]`
   `&dropoffLat=..&dropoffLon=..[&dropoffAddress=..]`
   `[&profile=carFast] [&stops=<JSON array of {lat,lon,address}>]`.
   `profile` defaults to `fastbike` for rides and `carFast` for deliveries.
2. `app/job-navigate.tsx` validates the params, reads the driver session token
   from `lib/_core/auth.ts` (`Auth.getSessionToken()`, expo-secure-store — the
   same token the tRPC client sends) and builds the C1 payload:
   - `upload.url = ${getApiBaseUrl()}/trpc/openrideTelemetry.ingestTrack`
   - `upload.token = <driver session bearer>`
   - `callbackScheme = ${EXPO_PUBLIC_SWITCHOS_URL_SCHEME ?? "switchos"}://job-complete`
3. `launchOpenRideNavigation()` base64url-encodes the JSON payload
   (base64 with `+/` → `-_`, padding stripped) and calls
   `Linking.canOpenURL` + `Linking.openURL`.
4. If no app handles `openride://`, the screen shows an install-guidance card
   instead of failing.
5. OpenRide navigates offline and uploads the C2 track summary directly to the
   server; it finishes by opening `switchos://job-complete?jobId=..&status=..`.
6. While `/job-navigate` is open, its `Linking.addEventListener("url")`
   listener parses the return link with `parseJobCompleteCallback()` and shows
   the status card. On a cold start, expo-router routes the deep link to
   `app/job-complete.tsx`, which renders the same status.

> **Upload URL note:** the C1 contract fixes the path as
> `/trpc/openrideTelemetry.ingestTrack`. This app's own tRPC client is mounted
> under `/api/trpc`; the server side of this integration must expose the ingest
> endpoint at the contract path (or the deployment must set
> `EXPO_PUBLIC_API_BASE_URL` accordingly). Do not silently change the path —
> it is part of the frozen contract.

## Phase 3 — place search

`PlaceSearchField` debounces input by 300 ms and calls
`trpc.openrideGeo.search.useQuery({ q, lat?, lon?, limit })` once at least
`minChars` (default 2) characters are entered. Results render name, kind, and
`distanceM` (when a reference `lat`/`lon` is supplied). Selection is delivered
through the `onSelect(place)` prop. Empty, loading and error (with retry)
states are built in.

```tsx
<PlaceSearchField
  lat={6.5176}
  lon={3.3787}
  onSelect={(place) => setDropoff(place)}
/>
```

Requires `openrideGeo.search` on the server `AppRouter` (delivered by the
server wave of this integration on the same PR branch); until that merges,
`components/PlaceSearchField.tsx` is the one file that does not type-check
against a stale `AppRouter`.

## Native configuration

### DeliveryPlatform (this app) — must handle `switchos://` and query `openride://`

Already configured in `app.config.ts` (scheme is env-overridable via
`SWITCHOS_MOBILE_URL_SCHEME`, default `switchos`):

```ts
scheme: env.scheme, // "switchos"
android: {
  intentFilters: [
    {
      action: "VIEW",
      autoVerify: true,
      data: [{ scheme: env.scheme, host: "*" }],
      category: ["BROWSABLE", "DEFAULT"],
    },
  ],
},
```

On iOS, Expo's `scheme` writes the `CFBundleURLTypes` entry automatically; the
raw `Info.plist` equivalent is:

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>switchos</string></array>
  </dict>
</array>
```

So that `Linking.canOpenURL("openride://…")` returns true, the app must also
declare the OpenRide scheme as queryable:

**iOS `Info.plist`:**

```xml
<key>LSApplicationQueriesSchemes</key>
<array>
  <string>openride</string>
</array>
```

**Android 11+ `android/app/src/main/AndroidManifest.xml`** (package
visibility — add next to the existing `<intent-filter>` entries, e.g. via
`expo prebuild` and the manifest, or a small config plugin):

```xml
<queries>
  <intent>
    <action android:name="android.intent.action.VIEW" />
    <data android:scheme="openride" />
  </intent>
</queries>
```

### OpenRide (Flutter app) — must handle `openride://`

**Android `android/app/src/main/AndroidManifest.xml`** (inside the launcher
`<activity>`):

```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="openride" />
</intent-filter>
```

**iOS `ios/Runner/Info.plist`:**

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>com.openride.app</string>
    <key>CFBundleURLSchemes</key>
    <array><string>openride</string></array>
  </dict>
</array>
```

And symmetrically, OpenRide needs `switchos` in its
`LSApplicationQueriesSchemes` / `<queries>` block to probe the return link.

## Deferred option — Flutter add-to-app embedding

Not in this phase. If the deep-link UX proves insufficient, OpenRide's Flutter
engine can be embedded into a native shell of this app via Flutter's
[add-to-app](https://docs.flutter.dev/add-to-app) flow (Flutter module →
AAR/CocoaPods), with platform channels replacing the deep-link contract for
job hand-off and a shared native module replacing the HTTP C2 upload. That
removes the install-check and inter-app round trip at the cost of bundling the
Flutter engine (~tens of MB) and maintaining a channel bridge; the C1 payload
schema (`openride.job.v1`) and the C2 track schema (`openride.track.v1`)
should be reused verbatim as the channel message formats so the contract stays
single-sourced.
