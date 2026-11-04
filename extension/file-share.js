// Call from the click handler without awaiting storage, permissions or wake locks.
// A successful handoff does not confirm that the receiving app saved the file.
export async function shareFile(blob,name) {
  try {
    if(typeof navigator?.share!=='function')return {status:'ready',message:'この環境ではファイル共有を利用できません。データは保持しています。対応ブラウザでの保存をご利用ください。'};
    const file=new File([blob],String(name).split(/[\\/]/).at(-1),{type:blob.type || 'application/octet-stream'});
    if(typeof navigator.canShare==='function' && !navigator.canShare({files:[file]}))return {status:'ready',message:'この形式のファイルを共有できません。データは保持しています。'};
    await navigator.share({files:[file],title:file.name});
    return {status:'shared',message:'共有先へ渡しました。保存先で確認してください。データはこの画面に保持しています。'};
  } catch(error) {
    return {status:'ready',message:error?.name==='AbortError'
      ? '共有をキャンセルしました。データは保持しています。もう一度保存・共有できます。'
      : '共有できませんでした。データは保持しています。「保存・共有」を押して再試行してください。'};
  }
}
