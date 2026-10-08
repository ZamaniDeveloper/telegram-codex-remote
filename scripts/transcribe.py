# Copyright (c) 2026 Mohsen Zamani / ZamaniDeveloper. See LICENSE.
"""Local CPU Whisper worker. Model downloads are restricted to install mode."""
import json
import os
import sys
import time
os.environ['HF_HUB_DISABLE_XET'] = '1'

def main():
    request = json.load(sys.stdin)
    model_path = request['modelPath']
    from faster_whisper import WhisperModel
    if request.get('install'):
        # Verify the audio decoder API too, before declaring the installation ready.
        from io import BytesIO
        import wave
        from faster_whisper.audio import decode_audio
        sample = BytesIO()
        with wave.open(sample, 'wb') as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(bytes(32000))
        sample.seek(0)
        if len(decode_audio(sample)) != 16000:
            raise ValueError('Audio decoder verification failed')
        from faster_whisper.utils import download_model
        for attempt in range(3):
            try:
                download_model(request.get('model', 'small'), output_dir=model_path)
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(2)
        WhisperModel(model_path, device='cpu', compute_type='int8', local_files_only=True)
        print(json.dumps({'ready': True}))
        return
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import av
    # Reject excessively long audio before allocating the decoded waveform.
    with av.open(request['audioPath']) as container:
        stream = next((s for s in container.streams if s.type == 'audio'), None)
        if stream is None:
            raise ValueError('No audio stream')
        duration = (stream.duration * stream.time_base if stream.duration else (container.duration or 0) / 1000000)
        if duration <= 0 or duration > 600:
            raise ValueError('Audio duration must be between 0 and 600 seconds')
    model = WhisperModel(model_path, device='cpu', compute_type='int8', local_files_only=True, cpu_threads=4)
    segments, info = model.transcribe(request['audioPath'], language=request.get('language') or None, beam_size=5, vad_filter=True)
    text = ' '.join(s.text.strip() for s in segments).strip()
    if not text or len(text) > 50000:
        raise ValueError('Empty or excessive transcript')
    print(json.dumps({'text': text, 'language': info.language, 'duration': info.duration}, ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Do not expose model logs, paths or audio contents in diagnostic output.
        print(json.dumps({'error': 'Local transcription failed. Check the model installation and audio (maximum 10 minutes).'}))
        sys.exit(1)
