EarCopy Assist ${VERSION} - Corresponding Sources
==================================================

This archive contains source code for LGPL-covered components distributed in
the EarCopy Assist ${VERSION} distribution package.

Source repository:
  https://github.com/tori128/sheetMusicHelper
Source commit:
  ${SOURCE_COMMIT}

FFmpeg 8.1.2
-------------
Binary locations:
  resources\backend\_internal\tools\ffmpeg.exe
  resources\backend\_internal\tools\ffprobe.exe

Source:
  ffmpeg-8.1.2.tar.xz
  https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
SHA-256:
  464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c
Build instructions:
  build_ffmpeg_lgpl.ps1

The build script records the exact configure options used for EarCopy Assist.
It requires MSYS2 MINGW64 with GCC and make.

libsndfile 1.2.2
----------------
Binary location:
  resources\backend\_internal\_soundfile_data\libsndfile_x64.dll

Source:
  libsndfile-1.2.2.tar.xz
  https://github.com/libsndfile/libsndfile/releases/download/1.2.2/libsndfile-1.2.2.tar.xz
SHA-256:
  3799ca9924d3125038880367bf1468e53a1b7e3686a934f098b7e1d286cdb80e
Build instructions:
  build_libsndfile_lgpl.ps1

The build disables external codecs and MPEG support. The resulting replaceable
DLL depends only on Windows system libraries. The upstream release archive
includes all source and CMake build files used by the script.

Python-SoXR 1.1.0 and its modified libsoxr
------------------------------------------
Binary location:
  resources\backend\_internal\soxr\soxr_ext.cp311-win_amd64.pyd

Source:
  soxr-1.1.0.tar.gz
  https://files.pythonhosted.org/packages/ed/11/27cebce4a108f77afea7c80545115536b45e3f11ebfb914f638fdd9ba847/soxr-1.1.0.tar.gz
SHA-256:
  9f228ae21c78fa9359ca98d8a5e8e91f30639e438e574133dace62c5b5309e44

The official Python source distribution includes the wrapper, its modified
libsoxr source, PFFFT, and build configuration.

License texts
-------------
The source archives contain their upstream license texts. Copies of the
applicable license notices are also included in the distribution package under:

  resources\backend\_internal\licenses\

This source archive is provided for license compliance. EarCopy Assist itself
is governed by LICENSE.txt in the distribution package.
