# WikiMasters — Images perso

Extension Chrome (Manifest V3) pour [WikiMasters](https://www.wiki-masters.com/), le jeu de collection de cartes tirées de Wikipédia.

Certaines cartes n'ont pas d'image, ou en ont une qui ne convient pas. Cette extension te permet de leur donner ta propre image, carte par carte, directement dans le jeu.

> Projet personnel, **non affilié à WikiMasters**. L'extension ne modifie que l'affichage dans ton navigateur : rien n'est envoyé au site ni à un serveur tiers.

## Fonctionnalités

- **Remplacement par carte**, avec deux modes :
  - **Toujours** : ton image remplace celle du site ;
  - **Si manquante** : ton image n'apparaît que si la carte n'a pas d'image.
- **Partout sur le site** : collection, « Toutes les cartes », marché, fenêtre de détail d'une carte.
- **Éditeur avec rognage** au format exact de l'illustration des cartes, avec aperçu en taille réelle. Plusieurs façons d'ajouter une image :
  - choisir un fichier ;
  - coller une image ou son adresse (<kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>V</kbd>) ;
  - saisir l'adresse d'une image ;
  - glisser-déposer une image depuis un dossier ou depuis un autre onglet.
- **Page « Mes images »** : toutes tes images au même endroit, avec recherche, filtre, tri, changement de mode et suppression.
- **Sauvegarde et transfert** : export dans un fichier `.json`, puis import sur un autre PC. À l'import, tu choisis entre fusionner en écrasant, fusionner sans écraser, ou tout remplacer.

## Installation

L'extension n'est pas publiée sur le Chrome Web Store. Pour l'installer en mode développeur :

1. Télécharge ce dépôt (bouton **Code → Download ZIP**, puis décompresse-le), ou clone-le.
2. Ouvre `chrome://extensions` dans Chrome.
3. Active le **Mode développeur** (en haut à droite).
4. Clique sur **Charger l'extension non empaquetée** et sélectionne le dossier du dépôt (celui qui contient `manifest.json`).
5. Recharge tes onglets wiki-masters.com.

## Utilisation

1. Sur une page de wiki-masters.com qui affiche des cartes, clique sur l'icône de l'extension.
2. La popup liste les cartes de la page. Clique sur **Ajouter une image** pour une carte.
3. Dans l'éditeur, choisis une image, cadre-la (fais glisser pour la déplacer, molette ou curseur pour zoomer), choisis le mode, puis **Enregistrer**.

Pour gérer toutes tes images, clique sur **Mes images** en haut de la popup.

### Transférer ses images sur un autre PC

1. Dans **Mes images**, ouvre **Sauvegarde / transfert**, puis clique sur **Télécharger la sauvegarde**.
2. Sur l'autre PC, installe l'extension, ouvre la même page et importe le fichier.

## Permissions

| Permission | Pourquoi |
| --- | --- |
| `storage`, `unlimitedStorage` | Enregistrer tes images dans le navigateur (en base64, dans `chrome.storage.local`). |
| Accès à `wiki-masters.com` | Afficher tes images sur les cartes du site. |
| Accès à d'autres sites (facultatif) | Uniquement si tu charges une image depuis l'adresse d'un site qui bloque le téléchargement direct. Chrome te demande alors l'autorisation pour ce site précis. |

## Fonctionnement technique

- `src/page-hook.js` s'exécute dans la page. Il lit les réponses de l'API du site pour connaître l'identifiant unique (UUID) de chaque carte, car le HTML ne l'affiche pas.
- `src/content.js` repère les cartes dans la page. Il surveille les changements (pagination, fenêtres, rendu React) avec un `MutationObserver` et superpose ton image sur l'illustration. L'image d'origine du site n'est jamais modifiée.
- `src/storage.js` gère le stockage, partagé par toutes les parties de l'extension. Une image est enregistrée par UUID quand il est connu, sinon par nom de carte.

```
├── manifest.json
├── src/        page-hook.js, content.js, storage.js
├── popup/      liste des cartes de la page active
├── editor/     choix et rognage de l'image
├── manage/     page « Mes images »
├── backup/     sauvegarde et import
└── tests/      tests de la sauvegarde et de l'import
```

## Tests

Les tests couvrent l'export, la lecture d'une sauvegarde et les trois modes d'import. Ils nécessitent Node.js 18 ou plus récent :

```bash
node --test
```

## Crédits

Extension créée par [clepix21](https://github.com/clepix21).

## Licence

Copyright © 2026 clepix21. Tous droits réservés. Voir [LICENSE](LICENSE).
