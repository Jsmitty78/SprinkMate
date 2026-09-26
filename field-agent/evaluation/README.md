# 実写・AR概測の独立評価

このフォルダはサーバーの配信対象ではありません。正解ラベルを仕事の指示や観測候補へ混ぜず、推定結果の保存後にここで評価します。

実写／実機データはまだ収集していません。合成リプレイは入力・保存・判定・要求・資料の処理確認です。実写認識率やARの精度を示しません。

1. 実物の型式・取付状態・方向と重力基準を独立に確認して正解を付ける。
2. 写真で推定できない場合も `predicted: null` として記録する。判定できた写真だけに絞らない。
3. 基準長を別の測定手段で取得する。ARの誤hitは `wrongHit: true`、計測不能は `measuredMeters: null` として記録する。
4. 下の形式でサーバー配信外の `evaluation/private/` へ保存し、`pnpm evaluate:real evaluation/private/input.json evaluation/private/report.json` を実行する。

```json
{
  "orientationCases": [],
  "measurementCases": []
}
```

方向ケース: `{ "id": "photo-001", "synthetic": false, "expected": "pendent", "predicted": null }`

概測ケース: `{ "id": "length-001", "synthetic": false, "referenceMeters": 2, "measuredMeters": null, "wrongHit": false }`

空配列の出力は未評価です。`synthetic: false` は評価担当者が実記録であることを確認して付けます。評価器は記録の物理的真正性を認証するものではありません。実写の正解・基準長・誤hit分類は独立に確認します。

出力は方向の正解・不正解・不明件数、分類できた中での正解率、概測の誤hit／計測不能件数、正しいhitの絶対誤差・符号付き誤差・最大誤差です。独自の合格閾値や設備全体の適合判定は設けません。
