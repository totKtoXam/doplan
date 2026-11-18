/** English strings of the GitHub sync: header button, dialogs, conflict choice, notices. */
import { addTranslations } from '@/i18n'

addTranslations('en', {
  // state
  'Проверяю GitHub…': 'Checking GitHub…',
  'Синхронизация с GitHub недоступна': 'GitHub sync is not available',
  'Проект не подключён к GitHub': 'The project is not connected to GitHub',
  'Подключено к {repo}, но проект ещё не отправлен': 'Connected to {repo}, but the project has not been sent yet',
  'Синхронизировано с {repo}': 'In sync with {repo}',
  'Есть неотправленные версии ({n}) — нажмите «Отправить на GitHub»': 'There are versions not sent yet ({n}): press “Send to GitHub”',
  'На GitHub есть новые версии ({n}) — нажмите «Получить изменения»': 'GitHub has new versions ({n}): press “Get changes”',
  'Новые версии есть и здесь ({a}), и на GitHub ({b}): получите изменения, затем отправьте свои':
    'There are new versions both here ({a}) and on GitHub ({b}): get the changes, then send yours',
  'Не удалось проверить GitHub:': 'Could not check GitHub:',
  'GitHub не подключён': 'GitHub is not connected',

  // header button and menu
  'Отправляю на GitHub…': 'Sending to GitHub…',
  'Получаю изменения с GitHub…': 'Getting changes from GitHub…',
  'Подключаю GitHub…': 'Connecting GitHub…',
  'Объединяю версии…': 'Combining versions…',
  'Отключаю…': 'Disconnecting…',
  'Отправить на GitHub': 'Send to GitHub',
  'Получить изменения': 'Get changes',
  'Проверить сейчас': 'Check now',
  'Открыть на GitHub': 'Open on GitHub',
  'GitHub…': 'GitHub…',
  'Отключить от GitHub…': 'Disconnect from GitHub…',
  'Подключить…': 'Connect…',

  // actions and notices
  'Открыта старая версия': 'An old version is open',
  'Вернитесь к текущей версии («К текущей»), потом синхронизируйте с GitHub.': 'Go back to the current version (“To current”), then sync with GitHub.',
  'Изменения с GitHub объединены с вашими': 'The changes from GitHub were combined with yours',
  'Получены изменения с GitHub': 'Got the changes from GitHub',
  'На GitHub есть новые версии — сначала получаю их': 'GitHub has new versions: getting them first',
  'Отправлено на GitHub': 'Sent to GitHub',
  'На GitHub нет ничего нового': 'Nothing new on GitHub',
  'Версия с GitHub сохранена отдельным проектом: {name}': 'The GitHub version was saved as a separate project: {name}',
  Открыть: 'Open',
  'Взята версия с GitHub': 'Took the GitHub version',
  'Оставлена ваша версия': 'Kept your version',
  'Проект отправлен на GitHub': 'The project was sent to GitHub',
  'Отключить от GitHub?': 'Disconnect from GitHub?',
  'Проект перестанет синхронизироваться с репозиторием {name}. Сам репозиторий на GitHub и все версии на этом компьютере останутся; подключить снова можно в любой момент.':
    'The project will stop syncing with the repository {name}. The repository on GitHub and all versions on this computer stay; you can connect again at any time.',
  Отключить: 'Disconnect',
  'Проект отключён от GitHub': 'The project was disconnected from GitHub',

  // main dialog
  'Отправка — только по кнопке. doplan раз в несколько минут проверяет, нет ли на GitHub новых версий, и показывает это на кнопке GitHub в шапке.':
    'Sending happens only when you press the button. Every few minutes doplan checks GitHub for new versions and shows it on the GitHub button in the header.',
  'GitHub хранит копию проекта со всеми версиями в интернете: с ней можно работать на другом компьютере или вместе с кем-то. Пароль GitHub doplan не видит и не хранит — вход выполняется на сайте github.com.':
    'GitHub keeps a copy of the project with all its versions online: you can work on it from another computer or together with someone. doplan never sees or stores your GitHub password: you sign in on github.com.',
  'Способ подключения': 'How to connect',
  'Создать репозиторий': 'Create a repository',
  'Вставить ссылку': 'Paste a link',
  'Создайте на github.com пустой репозиторий (без README) и вставьте сюда его адрес из строки браузера. Подойдёт и ссылка git@github.com:… для SSH.':
    'Create an empty repository on github.com (without a README) and paste its address from the browser’s address bar here. A git@github.com:… link for SSH works too.',
  'Это не похоже на адрес репозитория GitHub: нужно https://github.com/владелец/имя': 'This does not look like a GitHub repository address: it should be https://github.com/owner/name',
  'Репозиторий: {repo}': 'Repository: {repo}',
  'При первой отправке может открыться окно входа в GitHub — войдите там, doplan пароль не увидит.':
    'The first send may open a GitHub sign-in window: sign in there, doplan will not see the password.',
  'Подключаю…': 'Connecting…',
  'Подключить и отправить': 'Connect and send',
  'Ищу GitHub CLI…': 'Looking for GitHub CLI…',
  'Шаг {n} из {of}': 'Step {n} of {of}',
  'Установка GitHub CLI': 'Installing GitHub CLI',
  'Чтобы doplan сам создал репозиторий, нужна бесплатная программа GitHub CLI (gh) от GitHub. Установите её один раз — это займёт пару минут.':
    'To create the repository for you, doplan needs GitHub CLI (gh), a free program from GitHub. Install it once: it takes a couple of minutes.',
  'Установить GitHub CLI': 'Install GitHub CLI',
  Инструкция: 'Instructions',
  'Выполните в терминале:': 'Run in a terminal:',
  'Команда скопирована': 'Command copied',
  Копировать: 'Copy',
  'Инструкция по установке': 'Install instructions',
  'Открылось окно установки. Когда оно закончит работу, нажмите «Проверить снова».': 'An install window opened. When it is done, press “Check again”.',
  'Проверить снова': 'Check again',
  'Проверяю…': 'Checking…',
  'GitHub CLI (gh) долго не отвечает — компьютер сейчас сильно загружен (например, антивирус проверяет файлы). Подождите немного и проверьте снова: повторный вход не нужен.':
    'GitHub CLI (gh) is taking too long to answer — the computer is very busy right now (e.g. an antivirus scan). Wait a little and check again: there is no need to sign in again.',
  'Проверяю вход в GitHub…': 'Checking the GitHub sign-in…',
  'Создаю репозиторий на GitHub…': 'Creating the repository on GitHub…',
  'Отправляю проект…': 'Sending the project…',
  '{n} из 3': '{n} of 3',
  'Не хотите устанавливать? Создайте репозиторий на github.com сами и выберите «Вставить ссылку».':
    'Rather not install it? Create the repository on github.com yourself and choose “Paste a link”.',
  'Вход в GitHub': 'Signing in to GitHub',
  'GitHub CLI установлен. Войдите в свой аккаунт GitHub через браузер: doplan покажет одноразовый код, его нужно ввести на странице GitHub.':
    'GitHub CLI is installed. Sign in to your GitHub account in the browser: doplan shows a one-time code to enter on the GitHub page.',
  'Вход в GitHub выполнен: {user}': 'Signed in to GitHub: {user}',
  'Вход в GitHub выполнен': 'Signed in to GitHub',
  'Вход не выполнен': 'Not signed in',
  'Ваш одноразовый код': 'Your one-time code',
  'Скопировать код': 'Copy the code',
  'Код скопирован': 'Code copied',
  'Открыть страницу GitHub': 'Open the GitHub page',
  'Вставьте код на странице github.com/login/device и подтвердите доступ. Окно обновится само.':
    'Paste the code on github.com/login/device and confirm the access. This window updates by itself.',
  'Получаю код…': 'Getting a code…',
  'Войти в GitHub': 'Sign in to GitHub',
  'Новый репозиторий': 'New repository',
  'Вы вошли в GitHub как {user}': 'Signed in to GitHub as {user}',
  'Вы вошли в GitHub': 'Signed in to GitHub',
  обновить: 'refresh',
  'Имя репозитория': 'Repository name',
  'Только латинские буквы, цифры, точка, дефис и подчёркивание, до 100 символов; в начале не дефис': 'Only Latin letters, digits, dot, hyphen and underscore, up to 100 characters, not starting with a hyphen',
  Доступ: 'Access',
  Приватный: 'Private',
  Публичный: 'Public',
  'Видите только вы и те, кого вы пригласите на GitHub.': 'Only you and the people you invite on GitHub can see it.',
  'Проект — план, модели, текстуры — сможет посмотреть и скачать любой человек в интернете.':
    'Anyone on the internet will be able to see and download the project: the plan, models and textures.',
  'Создаю и отправляю…': 'Creating and sending…',
  'Создать и отправить': 'Create and send',

  // conflict
  'план (стены, комнаты, мебель)': 'the plan (walls, rooms, furniture)',
  'описание проекта': 'the project description',
  'инструкции для ИИ': 'the AI instructions',
  'файл ресурса {name}': 'the asset file {name}',
  'Проект изменён и здесь, и на GitHub': 'The project changed both here and on GitHub',
  'Решить позже': 'Decide later',
  'Одни и те же части проекта поменялись и на этом компьютере, и на GitHub, и объединить их само не получилось:':
    'The same parts of the project changed both on this computer and on GitHub, and they could not be combined automatically:',
  'Выберите, какую версию оставить. Ничего не пропадёт: другая версия останется в истории версий.':
    'Choose which version to keep. Nothing is lost: the other version stays in the version history.',
  'Оставить мою версию': 'Keep my version',
  'Проект останется как на экране; при отправке он заменит версию на GitHub.': 'The project stays as on screen; when sent, it replaces the version on GitHub.',
  'Взять версию с GitHub': 'Take the GitHub version',
  'Проект станет как на GitHub. Ваша версия останется в истории версий — к ней можно вернуться.':
    'The project becomes as on GitHub. Your version stays in the version history: you can go back to it.',
  'Сохранить обе': 'Keep both',
  'Здесь остаётся ваша версия, а версия с GitHub сохраняется рядом отдельной папкой проекта — сравните и перенесите нужное.':
    'Your version stays here and the GitHub version is saved next to it as a separate project folder: compare them and move over what you need.',
  'Редактирование продолжится, когда проект обновится. Если откроется окно входа в GitHub — войдите в нём.':
    'Editing resumes once the project is updated. If a GitHub sign-in window opens, sign in there.',
  'Проект изменён во время обмена с GitHub': 'The project changed during the exchange with GitHub',
  'Пока шёл обмен с GitHub, в проекте появились несохранённые правки. Загрузить версию, полученную с GitHub (эти правки пропадут), или оставить на экране свои?':
    'Unsaved edits appeared in the project during the exchange with GitHub. Load the version received from GitHub (these edits will be lost) or keep yours on screen?',
  'Оставить мои правки': 'Keep my edits',
  'Загрузить с GitHub': 'Load from GitHub',
  'Версии на GitHub снова изменились, пока шла отправка. Попробуйте отправить ещё раз чуть позже.':
    'The versions on GitHub changed again while sending. Try sending again a little later.',
})
