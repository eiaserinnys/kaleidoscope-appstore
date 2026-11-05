# kaleidoscope 앱스토어

앱을 둘러볼 주소: https://kaleidoscope.eiaserinnys.me/appstore/index.html

## 앱 올리기

1. 이 저장소를 포크합니다.
2. `apps/{앱 id}/`에 앱 정의 `app.json`과 스토어 정보 `store.json`, 필요한 자산과 스크린샷을 넣습니다.
3. Pull Request를 보냅니다. `publisher`에는 본인의 GitHub 로그인을 적습니다.

`store.json`에는 `summary`, `description`, `category`, `publisher`, `release`, `listed`, `icon`, `assets`를 적습니다. `icon`은 자산 파일 경로 또는 `null`입니다. 각 자산에는 `id`, `version`, `file`, `format`, `source`, `license`를 적고, `id`와 `version`은 `app.json`의 `assets`와 맞춥니다. 파일은 `assets/` 아래에 두고 스크린샷은 `screenshots/1.png`처럼 1부터 5까지 번호를 붙입니다.

연결 권한을 사용하는 앱은 `store.json`의 `connections` 배열에 권한의 연결 이름마다 OAuth 연결 정의를 적습니다. `name`, `kind: "oauth"`, `base_url`, `paths`, `writable`, `description`이 필요하며 `issuer`, `resource`, `scopes`는 선택입니다. `name`은 소문자·숫자·하이픈으로 1~64자입니다. 주소는 HTTPS 또는 로컬 HTTP이며 인증정보·쿼리·조각을 넣지 않습니다. `paths`는 `/`로 시작하는 허용 경로입니다. relay와 헤더는 올릴 수 없습니다. 연결은 설치할 때 없으면 생성되고, 이미 같은 이름이 있으면 그대로 유지됩니다.

검사는 앱 정의와 자산의 일치, 크기와 스크린샷 형식, 비밀값 모양, 기본 앱 id와 게시자를 확인합니다. 스크린샷은 PNG 또는 WebP 다섯 장까지이고 장당 2 MiB 이하여야 합니다. 자산 합계는 10 MiB 이하여야 합니다.

새 앱의 `release`는 1입니다. 앱 정의, 스토어 정보, 자산 또는 스크린샷을 바꿀 때마다 정확히 1씩 올립니다. 내용 없이 판만 올릴 수 없습니다. 한 번 배포한 판은 고칠 수 없습니다.

승인자는 권한과 서버에서 실행하는 코드를 살펴보고 자산 라이선스를 확인합니다. 남의 저작물이나 개인 정보는 올리지 마세요.

## 승인하는 사람에게

PR의 검사 결과는 작성자가 워크플로를 바꿔 위조할 수 있으므로 안내용입니다. 머지 전에 main의 검사 코드로 직접 확인하세요.

```sh
git fetch origin pull/번호/head
node tools/check.mjs --base origin/main --head FETCH_HEAD --author 작성자로그인
```

첫 초기화 PR은 main에 검사 코드가 없으므로 검사 코드와 모든 변경을 직접 검수합니다. 그 다음 PR부터 main의 검사 코드가 기준입니다.

이 스토어는 PR 작성자의 GitHub 로그인 외의 개인 정보를 모으지 않습니다. 내려 달라는 요청은 eiaserinnys@gmail.com으로 보내 주세요.

스키마 갱신: kaleidoscope에서 `cargo run -q -p kaleidoscope-contract --example app_schema`
