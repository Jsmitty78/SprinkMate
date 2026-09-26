# Field Agent for iPhone

SwiftUI / ARKit / RealityKit の iOS 18 以降向けクライアントです。`FieldAgent.xcodeproj` を開き、`FieldAgent` scheme を使用します。FocusEntity は commit `3e08b26f863957113f4d0b2d45cf6dfbd1a41333` に固定しています。

## 起動

1. `field-agent` のサーバーを起動します。iPhone 実機から接続する場合、Mac と同じネットワークを使用し、サーバーの起動環境に `FIELD_AGENT_HOST=0.0.0.0` を設定します。
2. Xcode で実機を選び、Signing & Capabilities の Team を自分の開発者アカウントに設定して実行します。カメラとローカルネットワークの利用を許可します。
3. アプリの設定に `http://MacのLANアドレス:4310` と、サーバーが発行した接続トークンを入力します。Simulator では `http://127.0.0.1:4310` を使えます。
4. 仕事を作成するか既存の仕事を開き、写真・2点計測・事実確認を追加します。「AIと確認を進める」は Pi を設定したサーバーで使用できます。

接続先は UserDefaults、トークンはこの端末の Keychain に保存します。初期図面は H1 / 下向きのサンプルです。図面の編集と成果物全体の閲覧は Web 側が担当します。

## 撮影と計測の境界

- `CaptureController` の ARSession がカメラを単独で所有します。写真も `ARFrame.capturedImage` から取得します。
- FocusEntity は照準表示専用です。平滑化された表示座標やカメラ前方の代替座標を計測に使いません。
- 計測は画面中央を通る raw raycast の2点間距離です。`existingPlaneGeometry`、次に `estimatedPlane` を試し、追跡が normal で実際に hit した点だけを保存できます。
- 端点と根拠画像に同じ `ARFrame.timestamp`、`captureSessionId`、`coordinateFrameId` を付けます。座標はメートル、行列は column major です。JPEG は portrait 向けに時計回り90度回転し、画像変換前の寸法と camera intrinsics を併記します。
- 中断・バックグラウンド化・再ローカライズでは未完了の端点を破棄します。追跡座標が変わった点を結びません。
- 保存前に両端の写真を見て対象点を人間が確認します。細い配管では背景の面への hit があり得ます。取得条件が整っても、画面と検証結果は精度を「未評価」のまま扱います。

LiDAR は必須ではありません。実機のカメラ、AR の表面推定、物理的な長さの精度は Simulator では検証できません。

## 再送と確認

`LocalOutbox` は撮影 JPEG を先に、送信 manifest を最後に atomic 書き込みします。アップロード順は写真 → 計測 → 要求への回答です。再送には元の bytes と ID を使い、全工程の応答が成功した後に端末の送信待ちコピーを消します。起動時・通信復帰・手動操作で再送できます。別のサーバー向けに保存したデータは自動転送しません。

要求が古くなったなどのエラーではデータを残し、理由を表示します。別の送信待ち項目は続行できます。破棄・別要求への付け替え UI は初版に含めません。

AI の候補は未確認です。「根拠と照合して確認した」を項目ごとに選択し、根拠写真を指定した操作だけが manual / confirmed の事実になります。事実の更新はオンラインでサーバーの revision を照合します。確認要求への回答自体は送信待ち領域へ保存します。

## ビルドとテスト

既存 Xcode を指定し、システムの `xcode-select` 設定を変えずに実行できます。

```sh
cd field-agent/ios
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project FieldAgent.xcodeproj -scheme FieldAgent \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath .build -clonedSourcePackagesDirPath .build/SourcePackages \
  CODE_SIGNING_ALLOWED=NO build
```

インストール済み Simulator の ID を `xcrun simctl list devices available` で確認し、次を実行します。

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project FieldAgent.xcodeproj -scheme FieldAgent \
  -destination 'platform=iOS Simulator,id=<Simulator UUID>' \
  -derivedDataPath .build -clonedSourcePackagesDirPath .build/SourcePackages \
  CODE_SIGNING_ALLOWED=NO test
```

通常のテストは再起動後の outbox、失敗時の保持、途中書き込みの扱い、既存根拠への回答、AR の JSON 契約、接続 URL を検査します。実サーバーとの通信テストは通常 skip します。実行する場合はサーバーを起動し、上の `test` を `build-for-testing` に変更してから次を実行します。

```sh
python3 scripts/test-live-api.py --simulator '<Simulator UUID>'
```

このテストは `../.data/access-token` を読み、明示的な合成データで仕事作成・multipart 画像・再送・計測・要求回答・事実確認・検証・成果物作成を通し、最後にその仕事を中止します。トークン値はプロセス引数やプロジェクトに保存しません。物理的な計測のテストではありません。

プロジェクト定義は外部生成ツールなしで再生成できます。

```sh
python3 scripts/generate-project.py
```

## 実機で残る受け入れ確認

対象は LiDAR なし iPhone 16 です。署名・端末接続後に、権限と LAN 接続、撮影の向き、同じ対象の複数写真、既知長の2点計測、細管と背景面、中断からのやり直し、機内モードで保存してアプリ再起動後に再送、追加要求に答えて再検証する往復を確認します。これらが完了するまで実機成立や精度の保証とは扱いません。
