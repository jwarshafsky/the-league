// League data - 2026 season (current)
// yearAcquired: year player was drafted/acquired (minor league draft years marked in comments)
// fromMinors: true if player came through minor league system
// careerStat: career ABs for hitters, career IP for pitchers (used for minor league eligibility)
// sentDown: player was sent from majors back to minors ($10 fee)

const LEAGUE_DATA = {
  season: 2026,
  teams: [
    {
      id: "jeff",
      name: "Jeff",
      totalKeeperCost: 182,
      teamMoney: 264,
      draftBudget: 82,
      fees: 10,
      majors: [
        { name: "Bryce Harper", price: 24, yearAcquired: 2023, fromMinors: false },
        { name: "Bobby Witt Jr.", price: 49, yearAcquired: 2024, fromMinors: false },
        { name: "Willy Adames", price: 14, yearAcquired: 2024, fromMinors: false },
        { name: "Jackson Chourio", price: 15, yearAcquired: 2023, fromMinors: true },
        { name: "Chris Sale", price: 21, yearAcquired: 2024, fromMinors: false },
        { name: "Jazz Chisholm Jr.", price: 26, yearAcquired: 2024, fromMinors: false },
        { name: "Logan Gilbert", price: 23, yearAcquired: 2024, fromMinors: false },
        { name: "Will Smith", price: 10, yearAcquired: 2025, fromMinors: false }
      ],
      callups: [
        { name: "Coby Mayo", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Jonathan Aranda", yearAcquired: 2023, careerStat: 0, statType: "AB" },
        { name: "Brayden Taylor", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Alan Roden", yearAcquired: 2025, careerStat: 0, statType: "AB" }
      ],
      minors: [
        { name: "Roch Cholowsky", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Dalton Rushing", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Ryan Sloan", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Carson Williams", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Cole Young", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Josue Briceno", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Mike Sirota", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Alfredo Duno", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Jonny Farmelo", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Ryan Clifford", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Jacob Reimer", yearAcquired: 2026, careerStat: 0, statType: "AB" }
      ]
    },
    {
      id: "matt",
      name: "Matt",
      totalKeeperCost: 59,
      teamMoney: 254,
      draftBudget: 195,
      fees: 0,
      majors: [
        { name: "Cal Raleigh", price: 7, yearAcquired: 2024, fromMinors: false },
        { name: "Eugenio Suarez", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Trevor Story", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Brice Turang", price: 6, yearAcquired: 2024, fromMinors: false },
        { name: "Matt Chapman", price: 8, yearAcquired: 2024, fromMinors: false },
        { name: "Byron Buxton", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Garrett Crochet", price: 8, yearAcquired: 2024, fromMinors: false },
        { name: "Yoshinobu Yamamoto", price: 12, yearAcquired: 2023, fromMinors: true }
      ],
      callups: [],
      minors: [
        { name: "Jhostnyxon Garcia", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Gage Workman", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Travis Sykora", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Adrian Del Castillo", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Jurrangelo Cijntje", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Seth Hernandez", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Rainiel Rodriguez", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Jack Bauer", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Stryker Pence", yearAcquired: 2026, careerStat: 0, statType: "AB" }
      ]
    },
    {
      id: "jesse",
      name: "Jesse",
      totalKeeperCost: 151,
      teamMoney: 245,
      draftBudget: 94,
      fees: 0,
      majors: [
        { name: "Vinnie Pasquantino", price: 16, yearAcquired: 2025, fromMinors: false },
        { name: "Rafael Devers", price: 31, yearAcquired: 2025, fromMinors: false },
        { name: "Corbin Carroll", price: 54, yearAcquired: 2024, fromMinors: false },
        { name: "James Wood", price: 10, yearAcquired: 2023, fromMinors: true },
        { name: "Abner Uribe", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Wyatt Langford", price: 14, yearAcquired: 2024, fromMinors: false },
        { name: "Bo Bichette", price: 15, yearAcquired: 2025, fromMinors: false },
        { name: "Nathan Eovaldi", price: 5, yearAcquired: 2025, fromMinors: false }
      ],
      callups: [
        { name: "Jackson Holliday", yearAcquired: 2023, careerStat: 0, statType: "AB" },
        { name: "Chase Meidroth", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Colson Montgomery", yearAcquired: 2023, careerStat: 0, statType: "AB" }
      ],
      minors: [
        { name: "Ethan Conrad", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Juneiker Caceres", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Luis De Leon", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Walker Jenkins", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Justin Crawford", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Jesus Made", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Hunter Barco", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Juan Sanchez", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Carlos Lagrange", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "River Ryan", yearAcquired: 2026, careerStat: 0, statType: "IP" }
      ]
    },
    {
      id: "sam",
      name: "Sam",
      totalKeeperCost: 130,
      teamMoney: 258,
      draftBudget: 128,
      fees: 0,
      majors: [
        { name: "Masyn Winn", price: 3, yearAcquired: 2023, fromMinors: true },
        { name: "Junior Caminero", price: 15, yearAcquired: 2023, fromMinors: true },
        { name: "Teoscar Hernandez", price: 19, yearAcquired: 2024, fromMinors: false },
        { name: "Jackson Merrill", price: 5, yearAcquired: 2023, fromMinors: true },
        { name: "Tarik Skubal", price: 10, yearAcquired: 2023, fromMinors: false },
        { name: "Paul Skenes", price: 6, yearAcquired: 2024, fromMinors: false },
        { name: "Julio Rodriguez", price: 48, yearAcquired: 2025, fromMinors: false },
        { name: "CJ Abrams", price: 24, yearAcquired: 2024, fromMinors: false }
      ],
      callups: [
        { name: "Chandler Simpson", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Munetaka Murakami", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Josue De Paula", yearAcquired: 2023, careerStat: 0, statType: "IP" }
      ],
      minors: [
        { name: "Rece Hinds", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Jett Williams", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Charlie Condon", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Grant Taylor", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Spencer Jones", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Jaison Chourio", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Jonah Tong", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Colt Emerson", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Zac Veen", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Luis Lara", yearAcquired: 2026, careerStat: 0, statType: "AB" }
      ]
    },
    {
      id: "saxton",
      name: "Saxton",
      totalKeeperCost: 68,
      teamMoney: 257,
      draftBudget: 189,
      fees: 0,
      majors: [
        { name: "Shea Langeliers", price: 5, yearAcquired: 2025, fromMinors: false },
        { name: "Ben Rice", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Riley Greene", price: 19, yearAcquired: 2025, fromMinors: false },
        { name: "Michael King", price: 7, yearAcquired: 2023, fromMinors: false },
        { name: "Gleyber Torres", price: 4, yearAcquired: 2025, fromMinors: false },
        { name: "David Bednar", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Bryan Woo", price: 13, yearAcquired: 2025, fromMinors: false },
        { name: "Brandon Woodruff", price: 8, yearAcquired: 2025, fromMinors: false }
      ],
      callups: [
        { name: "Ryne Nelson", yearAcquired: 2023, careerStat: 0, statType: "IP" }
      ],
      minors: [
        { name: "Endy Rodr\u00edguez", yearAcquired: 2023, careerStat: 0, statType: "AB" },
        { name: "Luis Morales", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "DL Hall", yearAcquired: 2023, careerStat: 0, statType: "IP" },
        { name: "TJ Rumfield", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "AJ Smith-Shawver", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Sean Burke", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Logan Henderson", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Ben Joyce", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Tyler Locklear", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "CJ Kayfus", yearAcquired: 2026, careerStat: 0, statType: "AB" }
      ]
    },
    {
      id: "aj",
      name: "AJ",
      totalKeeperCost: 116,
      teamMoney: 261,
      draftBudget: 145,
      fees: 0,
      majors: [
        { name: "Josh Naylor", price: 10, yearAcquired: 2023, fromMinors: false },
        { name: "Robbie Ray", price: 5, yearAcquired: 2024, fromMinors: false },
        { name: "Logan Webb", price: 25, yearAcquired: 2023, fromMinors: false },
        { name: "Lawrence Butler", price: 8, yearAcquired: 2024, fromMinors: false },
        { name: "Cade Smith", price: 11, yearAcquired: 2025, fromMinors: false },
        { name: "Tanner Bibee", price: 5, yearAcquired: 2023, fromMinors: true },
        { name: "Pete Alonso", price: 40, yearAcquired: 2025, fromMinors: false },
        { name: "Andres Munoz", price: 12, yearAcquired: 2025, fromMinors: false }
      ],
      callups: [],
      minors: [
        { name: "Luisangel Acu\u00f1a", yearAcquired: 2023, careerStat: 0, statType: "AB" },
        { name: "Bryce Eldridge", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Termarr Johnson", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Deyvison De Los Santos", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Cam Collier", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Jace Laviolette", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Felnin Celesten", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Ryan Waldschmidt", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Khal Stephen", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Gage Jump", yearAcquired: 2026, careerStat: 0, statType: "IP" }
      ]
    },
    {
      id: "corey",
      name: "Corey",
      totalKeeperCost: 71,
      teamMoney: 276,
      draftBudget: 205,
      fees: 0,
      majors: [
        { name: "Alec Burleson", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Spencer Horwitz", price: 3, yearAcquired: 2025, fromMinors: false },
        { name: "Taj Bradley", price: 3, yearAcquired: 2023, fromMinors: true },
        { name: "Kevin Gausman", price: 9, yearAcquired: 2025, fromMinors: false },
        { name: "Dylan Cease", price: 13, yearAcquired: 2024, fromMinors: false },
        { name: "Noelvi Marte", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Cole Ragans", price: 25, yearAcquired: 2024, fromMinors: false },
        { name: "Trevor Rogers", price: 6, yearAcquired: 2025, fromMinors: false }
      ],
      callups: [
        { name: "Shane Baz", yearAcquired: 2023, careerStat: 0, statType: "IP" },
        { name: "Roman Anthony", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Kyle Teel", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Samuel Basallo", yearAcquired: 2024, careerStat: 0, statType: "AB" }
      ],
      minors: [
        { name: "Rhett Lowder", yearAcquired: 2024, careerStat: 0, statType: "IP" },
        { name: "Braden Montgomery", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Alex Freeland", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Eduardo Quintero", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Bryce Rainer", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Aiva Arquette", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Kaelen Culpepper", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Travis Bazzana", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Jarlin Susana", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Roki Sasaki", yearAcquired: 2024, careerStat: 0, statType: "IP" }
      ]
    },
    {
      id: "dave",
      name: "Dave",
      totalKeeperCost: 105,
      teamMoney: 263,
      draftBudget: 158,
      fees: 0,
      majors: [
        { name: "Ketel Marte", price: 19, yearAcquired: 2023, fromMinors: false },
        { name: "Randy Arozarena", price: 22, yearAcquired: 2025, fromMinors: false },
        { name: "Max Fried", price: 28, yearAcquired: 2025, fromMinors: false },
        { name: "Maikel Garcia", price: 6, yearAcquired: 2024, fromMinors: false },
        { name: "Tyler Soderstrom", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Edwin Diaz", price: 8, yearAcquired: 2023, fromMinors: false },
        { name: "Hunter Goodman", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Brent Rooker", price: 10, yearAcquired: 2023, fromMinors: false }
      ],
      callups: [
        { name: "Hurston Waldrep", yearAcquired: 2024, careerStat: 0, statType: "IP" },
        { name: "Jace Jung", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Mick Abel", yearAcquired: 2024, careerStat: 0, statType: "IP" },
        { name: "Doug Nikhazy", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Gavin Cross", yearAcquired: 2023, careerStat: 0, statType: "AB" },
        { name: "Evan Carter", yearAcquired: 2023, careerStat: 0, statType: "AB" },
        { name: "Chase Dollander", yearAcquired: 2025, careerStat: 0, statType: "IP" }
      ],
      minors: [
        { name: "Zyhir Hope", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Aidan Miller", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Tyson Lewis", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Christian Scott", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Didier Fuentes", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "A.J. Ewing", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Ralphy Velasquez", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Caleb Bonemer", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Teruaki Sato", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Hiromi Itoh", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Jordan Lawlar", yearAcquired: 2026, careerStat: 0, statType: "AB" }
      ]
    },
    {
      id: "josh-doug",
      name: "Josh/Doug",
      totalKeeperCost: 120,
      teamMoney: 259,
      draftBudget: 139,
      fees: 0,
      majors: [
        { name: "Bryson Stott", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Francisco Lindor", price: 33, yearAcquired: 2023, fromMinors: false },
        { name: "Ronald Acuna Jr.", price: 38, yearAcquired: 2025, fromMinors: false },
        { name: "Brendan Donovan", price: 5, yearAcquired: 2025, fromMinors: false },
        { name: "Brandon Nimmo", price: 11, yearAcquired: 2025, fromMinors: false },
        { name: "George Springer", price: 9, yearAcquired: 2025, fromMinors: false },
        { name: "Jacob deGrom", price: 8, yearAcquired: 2024, fromMinors: false },
        { name: "Zach Neto", price: 10, yearAcquired: 2025, fromMinors: false }
      ],
      callups: [
        { name: "Nick Kurtz", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Dylan Crews", yearAcquired: 2023, careerStat: 0, statType: "AB" },
        { name: "Matt Shaw", yearAcquired: 2024, careerStat: 0, statType: "AB" }
      ],
      minors: [
        { name: "Kade Anderson", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Ethan Holliday", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Emmanuel Rodriguez", yearAcquired: 2023, careerStat: 0, statType: "AB" },
        { name: "Jojo Parker", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Max Clark", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Justin Lebron", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Noah Schultz", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Konnor Griffin", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Leodalis De Vries", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Kevin McGonigle", yearAcquired: 2025, careerStat: 0, statType: "AB" }
      ]
    },
    {
      id: "larry",
      name: "Larry",
      totalKeeperCost: 137,
      teamMoney: 250,
      draftBudget: 113,
      fees: 10,
      majors: [
        { name: "Nico Hoerner", price: 3, yearAcquired: 2025, fromMinors: false },
        { name: "Michael Busch", price: 7, yearAcquired: 2025, fromMinors: false },
        { name: "Juan Soto", price: 64, yearAcquired: 2025, fromMinors: false },
        { name: "Wilyer Abreu", price: 1, yearAcquired: 2024, fromMinors: true },
        { name: "Shota Imanaga", price: 11, yearAcquired: 2024, fromMinors: false },
        { name: "Cade Horton", price: 3, yearAcquired: 2024, fromMinors: true },
        { name: "Jose Ramirez", price: 45, yearAcquired: 2024, fromMinors: false },
        { name: "Agustin Ramirez", price: 3, yearAcquired: 2025, fromMinors: true }
      ],
      callups: [
        { name: "Mois\u00e9s Ballesteros", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Brady House", yearAcquired: 2024, careerStat: 0, statType: "AB" }
      ],
      minors: [
        { name: "Connelly Early", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Kevin Alcantara", yearAcquired: 2023, careerStat: 0, statType: "AB" },
        { name: "James Triantos", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Jonathan Long", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Jackson Ferris", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Jaxon Wiggins", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Jefferson Rojas", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Elmer Rodriguez", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Jackson Flora", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Ace Reese", yearAcquired: 2026, careerStat: 0, statType: "AB" }
      ]
    },
    {
      id: "zack",
      name: "Zack",
      totalKeeperCost: 59,
      teamMoney: 259,
      draftBudget: 200,
      fees: 0,
      majors: [
        { name: "Ceddanne Rafaela", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Cristopher Sanchez", price: 8, yearAcquired: 2024, fromMinors: false },
        { name: "Mason Miller", price: 8, yearAcquired: 2024, fromMinors: false },
        { name: "Jasson Dominguez", price: 9, yearAcquired: 2024, fromMinors: false },
        { name: "Jesus Luzardo", price: 8, yearAcquired: 2025, fromMinors: false },
        { name: "Jeremy Pena", price: 8, yearAcquired: 2025, fromMinors: false },
        { name: "Kyle Bradish", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Kyle Stowers", price: 6, yearAcquired: 2025, fromMinors: false }
      ],
      callups: [
        { name: "Kyle Manzardo", yearAcquired: 2023, careerStat: 0, statType: "AB" },
        { name: "Chase Burns", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Chase Delauter", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "JJ Wetherholt", yearAcquired: 2025, careerStat: 0, statType: "AB" }
      ],
      minors: [
        { name: "Luis Pena", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Robby Snelling", yearAcquired: 2024, careerStat: 0, statType: "IP" },
        { name: "Harry Ford", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Tommy Troy", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Eli Willits", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Tyler Bremner", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Quinn Mathews", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Thomas White", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Sebastian Walcott", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "J.R. Ritchie", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Dylan Beavers", yearAcquired: 2026, careerStat: 0, statType: "AB", sentDown: true, sendDownCount: 1 },
        { name: "Logan Henderson", yearAcquired: 2026, careerStat: 0, statType: "IP" }
      ]
    },
    {
      id: "glicksman",
      name: "Glicksman",
      totalKeeperCost: 49,
      teamMoney: 274,
      draftBudget: 225,
      fees: 10,
      majors: [
        { name: "Dansby Swanson", price: 8, yearAcquired: 2024, fromMinors: false },
        { name: "Geraldo Perdomo", price: 6, yearAcquired: 2025, fromMinors: false },
        { name: "Pete Crow-Armstrong", price: 10, yearAcquired: 2023, fromMinors: true },
        { name: "Eury Perez", price: 8, yearAcquired: 2024, fromMinors: false },
        { name: "Ryan Pepiot", price: 3, yearAcquired: 2023, fromMinors: true },
        { name: "Hunter Brown", price: 8, yearAcquired: 2023, fromMinors: false },
        { name: "Drew Rasmussen", price: 5, yearAcquired: 2025, fromMinors: false },
        { name: "Jackson Jobe", price: 1, yearAcquired: 2024, fromMinors: true }
      ],
      callups: [
        { name: "Jacob Misiorowski", yearAcquired: 2024, careerStat: 0, statType: "IP" },
        { name: "Luke Keaschall", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Jordan Beck", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Jack Leiter", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Bubba Chandler", yearAcquired: 2025, careerStat: 0, statType: "IP" }
      ],
      minors: [
        { name: "George Lombard Jr.", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Owen Caissie", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Cooper Pratt", yearAcquired: 2025, careerStat: 0, statType: "AB" },
        { name: "Robert Gasser", yearAcquired: 2025, careerStat: 0, statType: "IP" },
        { name: "Liam Doyle", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Andrew Fischer", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Jac Caglianone", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Lazaro Montes", yearAcquired: 2024, careerStat: 0, statType: "AB" },
        { name: "Franklin Arias", yearAcquired: 2026, careerStat: 0, statType: "AB" },
        { name: "Brandon Sproat", yearAcquired: 2026, careerStat: 0, statType: "IP" },
        { name: "Bishop Letson", yearAcquired: 2026, careerStat: 0, statType: "AB" }
      ]
    }
  ]
};
