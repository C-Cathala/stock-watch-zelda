# Stock Switch 2 Zelda

Surveille le retour en stock de la **Nintendo Switch 2 Édition 40e anniversaire The Legend of Zelda** et prévient sur Discord.

## Ce que ça fait

- **Toutes les 10 minutes** : lit les fiches Amazon FR, Amazon DE, E.Leclerc, Carrefour et Auchan. Une fois par heure, lit aussi Alert&Go, qui suit 11 revendeurs (dont Fnac, Cdiscount, Micromania, Cultura, Boulanger). Si un revendeur passe en stock, message `@everyone` dans le salon Discord.
- **Chaque matin (7h, puis 6h après le 25/10)** : point du jour. Actus sur le stock, revendeurs en stock, et état de chaque source.
- **Si plus rien ne se lit pendant 1 h** : message d'alerte.
- Au-dessus de 600 €, une offre Amazon est considérée comme un revendeur tiers : pas d'alerte.

## Limites

- GitHub lance les tâches planifiées avec parfois 5 à 15 minutes de retard.
- Fnac, Cdiscount, Micromania, Cultura et Boulanger bloquent les robots. Ils ne sont vus qu'à travers Alert&Go, mis à jour environ une fois par jour.
- Le Nintendo Store est derrière une file d'attente. Ses réassorts sont annoncés dans l'app Nintendo Store : active ses notifications.
- L'alerte part quand la mention « rupture » disparaît d'une fiche. Une refonte de la fiche peut donc donner une fausse alerte.

## Commandes

```bash
node watch.mjs stock --dry
```

```bash
node watch.mjs news --dry
```

Test à la demande : onglet Actions > watch > Run workflow (mode `test`, `stock` ou `news`).

## Arrêter

Onglet Actions > watch > « Disable workflow ». Ou supprimer le repo une fois la console achetée.
